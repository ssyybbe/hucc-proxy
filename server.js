// ============================================================
// Creatio Proxy — sert d'intermédiaire serveur entre le widget
// HUCC (navigateur) et Creatio, pour éviter les erreurs CORS.
//
// Le widget HUCC n'appelle plus jamais Creatio directement :
// il appelle CE serveur, qui lui-même parle à Creatio en
// server-to-server (aucun navigateur impliqué → pas de CORS).
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const tough = require("tough-cookie");
const fetchCookie = require("fetch-cookie");
const nodeFetch = require("node-fetch");

const CREATIO_BASE_URL = process.env.CREATIO_BASE_URL; // ex: https://stlia-demo.creatio.com
const CREATIO_LOGIN    = process.env.CREATIO_LOGIN;
const CREATIO_PASSWORD = process.env.CREATIO_PASSWORD;
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN;   // domaine qui héberge le widget HUCC
const PORT             = process.env.PORT || 3001;

if (!CREATIO_BASE_URL || !CREATIO_LOGIN || !CREATIO_PASSWORD || !ALLOWED_ORIGIN) {
    console.error("ERREUR : variables d'environnement manquantes. Voir .env.example");
    process.exit(1);
}

// Cookie jar partagé : garde la session Creatio (cookies) en mémoire serveur
const cookieJar = new tough.CookieJar();
const fetch = fetchCookie(nodeFetch, cookieJar);

let bpmcsrfToken = null;
let loginInFlight = null;

// ------------------------------------------------------------
// Login Creatio (server-to-server, jamais depuis le navigateur)
// ------------------------------------------------------------
async function loginCreatio() {
    if (loginInFlight) return loginInFlight; // évite les logins concurrents

    loginInFlight = (async () => {
        console.log("CREATIO-PROXY : login en cours...");
        const res = await fetch(CREATIO_BASE_URL + "/ServiceModel/AuthService.svc/Login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                UserName: CREATIO_LOGIN,
                UserPassword: CREATIO_PASSWORD
            })
        });
        const data = await res.json();
        if (data.Code !== 0) {
            throw new Error("Login Creatio échoué, code=" + data.Code);
        }
        const cookies = await cookieJar.getCookies(CREATIO_BASE_URL);
        const csrf = cookies.find(c => c.key === "BPMCSRF" || c.key === "CRT_CSRF");
        bpmcsrfToken = csrf ? csrf.value : null;
        console.log("CREATIO-PROXY : login OK, BPMCSRF =", bpmcsrfToken);
        return bpmcsrfToken;
    })();

    try {
        return await loginInFlight;
    } finally {
        loginInFlight = null;
    }
}

async function ensureAuth() {
    if (!bpmcsrfToken) {
        await loginCreatio();
    }
}

// Wrapper fetch vers Creatio : ajoute le CSRF, retente une fois si session expirée
async function creatioFetch(path, options = {}, retry = true) {
    await ensureAuth();

    const headers = Object.assign(
        { "Content-Type": "application/json", "Accept": "application/json" },
        options.headers || {}
    );
    if (options.method && options.method !== "GET") {
        headers["BPMCSRF"] = bpmcsrfToken;
    }

    const res = await fetch(CREATIO_BASE_URL + path, Object.assign({}, options, { headers }));

    if (res.status === 401 && retry) {
        console.log("CREATIO-PROXY : session expirée, re-login...");
        bpmcsrfToken = null;
        await loginCreatio();
        return creatioFetch(path, options, false);
    }
    return res;
}

// ------------------------------------------------------------
// Serveur Express
// ------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN }));

// GET /api/contacts/search?phone=+33612345678
app.get("/api/contacts/search", async (req, res) => {
    try {
        const phoneNumber = req.query.phone;
        if (!phoneNumber) {
            return res.status(400).json({ error: "paramètre 'phone' requis" });
        }

        const phoneClean = phoneNumber.replace(/\s/g, "");
        const phoneLocal = phoneClean.replace(/^\+33/, "0");
        const filter = encodeURIComponent(
            "contains(Phone, '" + phoneClean + "')" +
            " or contains(MobilePhone, '" + phoneClean + "')" +
            " or contains(Phone, '" + phoneLocal + "')" +
            " or contains(MobilePhone, '" + phoneLocal + "')"
        );
        const url = "/0/odata/Contact?$select=Id,Name,Phone,MobilePhone&$filter=" + filter;

        const cRes = await creatioFetch(url, { method: "GET" });
        if (!cRes.ok) {
            console.error("CREATIO-PROXY : erreur recherche", cRes.status);
            return res.status(cRes.status).json({ error: "recherche Creatio échouée" });
        }

        const data = await cRes.json();
        const contacts = (data.value || []).map(c => ({
            objectId: c.Id,
            objectType: "contact",
            description: c.Name + " (" + (c.Phone || c.MobilePhone) + ")"
        }));
        console.log("CREATIO-PROXY : " + contacts.length + " contact(s) trouvé(s) pour", phoneNumber);
        res.json(contacts);
    } catch (err) {
        console.error("CREATIO-PROXY : erreur /contacts/search", err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/activities  { callerNumber, contactId }
app.post("/api/activities", async (req, res) => {
    try {
        const { callerNumber, contactId } = req.body;
        const data = {
            "Title": "Appel entrant - " + callerNumber,
            "TypeId": "e1c59272-5001-4d72-8f62-a4dc6e91f345", // GUID type "Appel"
            "PhoneNumber": callerNumber,
            "StartDate": new Date().toISOString(),
            "StatusId": "384d4ef6-55d6-df11-971b-001d60e938c6" // Statut "Terminé"
        };
        if (contactId) data.ContactId = contactId;

        const cRes = await creatioFetch("/0/odata/Activity", {
            method: "POST",
            body: JSON.stringify(data)
        });
        if (!cRes.ok) {
            console.error("CREATIO-PROXY : erreur création activité", cRes.status);
            return res.status(cRes.status).json({ error: "création activité échouée" });
        }

        const created = await cRes.json();
        console.log("CREATIO-PROXY : activité créée →", created.Id);
        res.json({ id: created.Id });
    } catch (err) {
        console.error("CREATIO-PROXY : erreur /activities", err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log("CREATIO-PROXY : serveur démarré sur le port " + PORT);
    loginCreatio().catch(err => console.error("CREATIO-PROXY : login initial échoué", err));
});
