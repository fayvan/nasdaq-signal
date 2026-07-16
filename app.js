const http = require('http');
const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
    // API 路由由 Vercel 处理，这里只处理静态文件
    let url = req.url.split('?')[0];
    
    if (url === '/') {
        url = '/index.html';
    }
    
    const filePath = path.join(__dirname, url);
    
    const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
    };
    
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'text/plain';
    
    try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    } catch (err) {
        // 文件不存在，返回 index.html
        try {
            const data = fs.readFileSync(path.join(__dirname, 'index.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        } catch (err2) {
            res.writeHead(404);
            res.end('Not Found');
        }
    }
};