const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const CREATIO_URL = 'https://dev-westlakeplastics.creatio.com';
const CORS_ORIGIN = 'https://cdn01.demo.hermes.vocalcom.com';

// ============================================================
// CORS : autoriser les appels depuis Vocalcom
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
// LOGIN : intercepté pour extraire le BPMCSRF et le mettre dans le body
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

        // Lire les cookies de la réponse Creatio
        const rawCookies = creatioRes.headers.raw()['set-cookie'] || [];
        let bpmcsrf = null;

        rawCookies.forEach(cookie => {
            if (cookie.includes('BPMCSRF=')) {
                const match = cookie.match(/BPMCSRF=([^;]+)/);
                if (match) bpmcsrf = match[1];
            }
            // Transmettre le cookie au navigateur
            res.append('Set-Cookie', cookie);
        });

        console.log("Login - Code:", data.Code, "| BPMCSRF:", bpmcsrf);

        // Injecter BPMCSRF dans le body pour que le JS puisse le lire
        res.json({ ...data, BPMCSRF: bpmcsrf });

    } catch (err) {
        console.error("Erreur login:", err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// TOUT LE RESTE : proxy transparent vers Creatio
// ============================================================
app.use('/', createProxyMiddleware({
    target: CREATIO_URL,
    changeOrigin: true,
    on: {
        proxyReq: function(proxyReq, req) {
            // Transmettre le header BPMCSRF si présent
            if (req.headers['bpmcsrf']) {
                proxyReq.setHeader('BPMCSRF', req.headers['bpmcsrf']);
            }
        },
        proxyRes: function(proxyRes) {
            // Supprimer le CORS de Creatio pour éviter les doublons
            delete proxyRes.headers['access-control-allow-origin'];
        }
    }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy démarré sur port", PORT));
