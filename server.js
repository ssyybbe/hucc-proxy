const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Autoriser les appels depuis Vocalcom
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", 
               "https://cdn01.demo.hermes.vocalcom.com");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", 
               "Content-Type,BPMCSRF");
    res.header("Access-Control-Allow-Methods", 
               "GET,POST,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// Tout proxifier vers Creatio
app.use('/', createProxyMiddleware({
    target: 'https://nds-pf1-demo.creatio.com',
    changeOrigin: true,
    on: {
        proxyRes: function(proxyRes) {
            // Supprimer le header CORS de Creatio
            // pour éviter les doublons
            delete proxyRes.headers['access-control-allow-origin'];
        }
    }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy démarré sur port", PORT));
