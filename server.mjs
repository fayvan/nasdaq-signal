#!/usr/bin/env node

/**
 * 纳指信号看板 - 本地服务
 * ============================
 * 启动方式：node server.mjs
 * 然后在浏览器打开 http://localhost:3456
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const HTML_FILE = path.join(__dirname, 'nasdaq-signal-dashboard.html');

// MIME 类型
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ── API 代理：获取纳指 100 周线数据 ──

async function fetchNDX() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?range=2y&interval=1wk&includePrePost=false';
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Yahoo API 返回 ${resp.status}`);
  const json = await resp.json();
  if (!json.chart?.result?.length) throw new Error('数据为空');
  return json;
}

// ── 计算指标 ──

function calcSMA(prices, period) {
  const r = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { r.push(null); continue; }
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += prices[j];
    r.push(s / period);
  }
  return r;
}

function calcRSI(prices, period) {
  if (prices.length < period + 1) return prices.map(() => null);
  const ch = [];
  for (let i = 1; i < prices.length; i++) ch.push(prices[i] - prices[i - 1]);
  const rsi = [null];
  let ag = 0, al = 0;
  for (let i = 0; i < period; i++) {
    if (ch[i] > 0) ag += ch[i]; else al += Math.abs(ch[i]);
  }
  ag /= period; al /= period;
  rsi.push(al < 0.0001 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = period; i < ch.length; i++) {
    const g = ch[i] > 0 ? ch[i] : 0, l = ch[i] < 0 ? Math.abs(ch[i]) : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    rsi.push(al < 0.0001 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return rsi;
}

function computeSignals(candles) {
  const prices = candles.map(c => c.close);
  const sma = calcSMA(prices, 20);
  const rsi = calcRSI(prices, 14);
  const last = candles.length - 1;
  const price = prices[last];
  const smaVal = sma[last];
  const rsiVal = rsi[last];
  const ath = Math.max(...prices);
  const dd = (price - ath) / ath;
  const smaDist = smaVal > 0 ? (price - smaVal) / smaVal : 0;

  const signals = { price, smaVal, rsiVal, drawdown: dd, smaDist, aboveSMA: price >= smaVal, score: 0, overall: 'HOLD', intensity: '⏸️ 持有/观望' };
  const buylist = [], selllist = [], holdlist = [];

  if (!signals.aboveSMA && smaDist < -0.02) { buylist.push('跌破20周均线 2%+'); signals.score += 2; }
  else if (!signals.aboveSMA && smaDist < 0) { buylist.push('略低于20周均线'); signals.score += 1; }
  else { holdlist.push('在20周均线上方'); }

  if (rsiVal !== null && rsiVal < 35) { buylist.push('RSI 超卖'); signals.score += 2; }
  else if (rsiVal !== null && rsiVal < 40) { buylist.push('RSI 偏低'); signals.score += 1; }
  else if (rsiVal !== null && rsiVal > 70) { selllist.push('RSI 超买'); signals.score -= 2; }
  else if (rsiVal !== null && rsiVal > 60) { selllist.push('RSI 偏高'); signals.score -= 1; }
  else if (rsiVal !== null) { holdlist.push('RSI 中性'); }

  if (dd < -0.15) { buylist.push('回撤 > 15%'); signals.score += 2; }
  else if (dd < -0.10) { buylist.push('回撤 10-15%'); signals.score += 1; }
  else if (dd < -0.05) { holdlist.push('小幅回调'); }
  else { holdlist.push('接近前高'); }

  if (signals.score >= 3) signals.overall = 'BUY';
  else if (signals.score <= -3) signals.overall = 'SELL';
  else if (buylist.length > 0 && selllist.length === 0) signals.overall = 'BUY';
  else if (selllist.length > 0 && buylist.length === 0) signals.overall = 'SELL';
  else if (buylist.length > 0 && selllist.length > 0) signals.overall = signals.score > 0 ? 'BUY' : signals.score < 0 ? 'SELL' : 'HOLD';

  const bc = buylist.length, sc = selllist.length;
  if (signals.overall === 'BUY') signals.intensity = (bc >= 3 || signals.score >= 4) ? '⚡ 加仓' : (bc >= 2 || signals.score >= 2) ? '📈 加仓' : '🌱 轻仓加注';
  else if (signals.overall === 'SELL') signals.intensity = (sc >= 2 || signals.score <= -4) ? '⚠️ 减仓/止盈' : '🔻 小幅减仓';
  else signals.intensity = '⏸️ 持有/观望';

  // 原始数据序列（给图表用）
  signals.candles = candles.map((c, i) => ({
    t: c.date.toISOString().slice(0, 10),
    p: c.close,
    sma: sma[i],
  }));
  signals.signals = { buy: buylist, sell: selllist, hold: holdlist };
  // 最近一次更新时间
  signals.lastTime = candles[last].date.toISOString();
  signals.ath = ath;

  return signals;
}

// ── HTTP 服务 ──

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API 端点
  if (url.pathname === '/api/signals') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const json = await fetchNDX();
      const result = json.chart.result[0];
      const ts = result.timestamp;
      const q = result.indicators.quote[0];
      const ac = result.indicators.adjclose?.[0]?.adjclose || q.close;
      const candles = ts.map((t, i) => ({
        date: new Date(t * 1000),
        close: q.close[i],
      })).filter(c => c.close !== null && c.close > 0)
        .sort((a, b) => a.date - b.date);

      const signals = computeSignals(candles);
      res.end(JSON.stringify({ ok: true, data: signals }));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // 健康检查
  if (url.pathname === '/api/ping') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
    return;
  }

  // 静态文件
  let filePath;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    filePath = HTML_FILE;
  } else {
    filePath = path.join(__dirname, url.pathname);
  }

  // 安全检查
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  📊 纳指信号看板');
  console.log('  ───────────────────────');
  console.log(`  打开 http://localhost:${PORT}`);
  console.log('');
});
