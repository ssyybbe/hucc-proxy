const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const CREATIO_URL = 'https://dev-westlakeplastics.creatio.com';
const CORS_ORIGIN = 'https://cdn01.demo.hermes.vocalcom.com';

// ============================================================
// Stockage de la session Creatio côté serveur
// ============================================================
var creatioSession = {
    cookies: null,   // string de cookies à réinjecter
    bpmcsrf: null    // token CSRF
};

// ============================================================
// CORS
// ============================================================
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Content-Type,BPMCSRF");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// ============================================================
// LOGIN : intercepté pour stocker la session côté proxy
// ============================================================
app.post('/ServiceModel/AuthService.svc/Login', async (req, res) => {
    try {
        const creatioRes = await fetch(
            CREATIO_URL + '/ServiceModel/AuthService.svc/Login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });

        const data = await creatioRes.json();
        const rawCookies = creatioRes.headers.raw()['set-cookie'] || [];

        let bpmcsrf = null;
        let cookieStrings = [];

        rawCookies.forEach(cookie => {
            // Extraire le BPMCSRF
            if (cookie.includes('BPMCSRF=')) {
                const match = cookie.match(/BPMCSRF=([^;]+)/);
                if (match) bpmcsrf = match[1];
            }
            // Garder uniquement nom=valeur pour les requêtes suivantes
            cookieStrings.push(cookie.split(';')[0]);
            // Transmettre le cookie au navigateur
            res.append('Set-Cookie', cookie);
        });

        // Stocker la session côté proxy
        creatioSession.cookies = cookieStrings.join('; ');
        creatioSession.bpmcsrf = bpmcsrf;

        console.log("Login OK - BPMCSRF:", bpmcsrf);
        console.log("Session cookies:", creatioSession.cookies);

        // Injecter BPMCSRF dans le body
        res.json({ ...data, BPMCSRF: bpmcsrf });

    } catch (err) {
        console.error("Erreur login:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// TOUT LE RESTE : proxy avec injection des cookies de session
// ============================================================
app.use('/', createProxyMiddleware({
    target: CREATIO_URL,
    changeOrigin: true,
    on: {
        proxyReq: function(proxyReq, req) {
            // Injecter les cookies de session Creatio
            if (creatioSession.cookies) {
                proxyReq.setHeader('Cookie', creatioSession.cookies);
                console.log("Proxy → Cookie injecté pour", req.url);
            }
            // Injecter le BPMCSRF si présent dans la requête
            if (req.headers['bpmcsrf']) {
                proxyReq.setHeader('BPMCSRF', req.headers['bpmcsrf']);
            } else if (creatioSession.bpmcsrf) {
                proxyReq.setHeader('BPMCSRF', creatioSession.bpmcsrf);
            }
        },
        proxyRes: function(proxyRes) {
            delete proxyRes.headers['access-control-allow-origin'];
        }
    }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy démarré sur port", PORT));
