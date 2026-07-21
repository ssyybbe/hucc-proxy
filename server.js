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
let isAuthenticated = false;
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

        // On lit le BPMCSRF directement depuis les en-têtes Set-Cookie
        // de LA RÉPONSE DE LOGIN (plus fiable que de repasser par le
        // cookie-jar, qui peut mal résoudre le domaine/chemin selon
        // la forme exacte de CREATIO_BASE_URL).
        var rawSetCookies = [];
        if (typeof res.headers.raw === "function") {
            rawSetCookies = res.headers.raw()["set-cookie"] || [];
        } else {
            // fallback si "raw" n'est pas dispo (Headers standard ne renvoie
            // qu'une valeur fusionnée pour get("set-cookie"))
            var single = res.headers.get("set-cookie");
            if (single) rawSetCookies = [single];
        }
        console.log("CREATIO-PROXY : Set-Cookie reçus →", rawSetCookies);

        bpmcsrfToken = null;
        for (var i = 0; i < rawSetCookies.length; i++) {
            var m = rawSetCookies[i].match(/^(BPMCSRF|CRT_CSRF)=([^;]+)/);
            if (m) {
                bpmcsrfToken = m[2];
                break;
            }
        }

        if (!bpmcsrfToken) {
            // Dernier recours : certains tenants ne renvoient le cookie
            // BPMCSRF qu'après un premier appel authentifié (GET simple).
            console.log("CREATIO-PROXY : BPMCSRF absent du login, tentative via un GET de secours...");
            var probeRes = await fetch(CREATIO_BASE_URL + "/0/odata/SysSettings?$top=1");
            var probeCookies = [];
            if (typeof probeRes.headers.raw === "function") {
                probeCookies = probeRes.headers.raw()["set-cookie"] || [];
            }
            console.log("CREATIO-PROXY : Set-Cookie du GET de secours →", probeCookies);
            for (var j = 0; j < probeCookies.length; j++) {
                var m2 = probeCookies[j].match(/^(BPMCSRF|CRT_CSRF)=([^;]+)/);
                if (m2) {
                    bpmcsrfToken = m2[2];
                    break;
                }
            }
        }

        isAuthenticated = true;
        console.log("CREATIO-PROXY : login OK, BPMCSRF =", bpmcsrfToken || "(aucun — protection CSRF désactivée sur cette instance)");
        return bpmcsrfToken;
    })();

    try {
        return await loginInFlight;
    } finally {
        loginInFlight = null;
    }
}

async function ensureAuth() {
    if (!isAuthenticated) {
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
    if (options.method && options.method !== "GET" && bpmcsrfToken) {
        headers["BPMCSRF"] = bpmcsrfToken;
    }

    const res = await fetch(CREATIO_BASE_URL + path, Object.assign({}, options, { headers }));

    if (res.status === 401 && retry) {
        console.log("CREATIO-PROXY : session expirée, re-login...");
        bpmcsrfToken = null;
        isAuthenticated = false;
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
            const errorBody = await cRes.text();
            console.error("CREATIO-PROXY : erreur création activité", cRes.status, errorBody);
            return res.status(cRes.status).json({ error: "création activité échouée", details: errorBody });
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
