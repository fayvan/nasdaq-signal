/**
 * Vercel Serverless Function — /api/signals
 * 返回纳指100的周线信号数据
 */
export default async function handler(req, res) {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?range=2y&interval=1wk&includePrePost=false';
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error('Yahoo API 返回 ' + resp.status);
    const json = await resp.json();
    if (!json.chart?.result?.length) throw new Error('数据为空');

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
    res.status(200).json({ ok: true, data: signals });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── 指标计算 ──

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

  const result = { price, smaVal, rsiVal, drawdown: dd, smaDist, aboveSMA: price >= smaVal, score: 0, overall: 'HOLD', intensity: '⏸️ 持有/观望' };
  const buylist = [], selllist = [], holdlist = [];

  if (!result.aboveSMA && smaDist < -0.02) { buylist.push('跌破20周均线 2%+'); result.score += 2; }
  else if (!result.aboveSMA && smaDist < 0) { buylist.push('略低于20周均线'); result.score += 1; }
  else { holdlist.push('在20周均线上方'); }

  if (rsiVal !== null && rsiVal < 35) { buylist.push('RSI 超卖'); result.score += 2; }
  else if (rsiVal !== null && rsiVal < 40) { buylist.push('RSI 偏低'); result.score += 1; }
  else if (rsiVal !== null && rsiVal > 70) { selllist.push('RSI 超买'); result.score -= 2; }
  else if (rsiVal !== null && rsiVal > 60) { selllist.push('RSI 偏高'); result.score -= 1; }
  else if (rsiVal !== null) { holdlist.push('RSI 中性'); }

  if (dd < -0.15) { buylist.push('回撤 > 15%'); result.score += 2; }
  else if (dd < -0.10) { buylist.push('回撤 10-15%'); result.score += 1; }
  else if (dd < -0.05) { holdlist.push('小幅回调'); }
  else { holdlist.push('接近前高'); }

  if (result.score >= 3) result.overall = 'BUY';
  else if (result.score <= -3) result.overall = 'SELL';
  else if (buylist.length > 0 && selllist.length === 0) result.overall = 'BUY';
  else if (selllist.length > 0 && buylist.length === 0) result.overall = 'SELL';
  else if (buylist.length > 0 && selllist.length > 0) result.overall = result.score > 0 ? 'BUY' : result.score < 0 ? 'SELL' : 'HOLD';

  const bc = buylist.length, sc = selllist.length;
  if (result.overall === 'BUY') result.intensity = (bc >= 3 || result.score >= 4) ? '⚡ 加仓' : (bc >= 2 || result.score >= 2) ? '📈 加仓' : '🌱 轻仓加注';
  else if (result.overall === 'SELL') result.intensity = (sc >= 2 || result.score <= -4) ? '⚠️ 减仓/止盈' : '🔻 小幅减仓';
  else result.intensity = '⏸️ 持有/观望';

  result.signals = { buy: buylist, sell: selllist, hold: holdlist };
  result.candles = candles.map((c, i) => ({ t: c.date.toISOString().slice(0, 10), p: c.close, sma: sma[i] }));
  result.lastTime = candles[last].date.toISOString();
  result.ath = ath;

  return result;
}
