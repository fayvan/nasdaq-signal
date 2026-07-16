/**
 * Vercel Serverless Function — /api/signals
 * 支持 market=us (纳指100) 和 market=cn (沪深300)
 *
 * 用法：GET /api/signals?market=us   (默认)
 *       GET /api/signals?market=cn
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const market = (req.query?.market || 'us').toLowerCase();

  try {
    const symbol = market === 'cn' ? '000300.SS' : '%5ENDX';

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1wk&includePrePost=false`;
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
    const candles = ts.map((t, i) => ({
      date: new Date(t * 1000),
      open: q.open[i], high: q.high[i], low: q.low[i],
      close: q.close[i], volume: q.volume[i] || 0,
    })).filter(c => c.close !== null && c.close > 0)
      .sort((a, b) => a.date - b.date);

    const cfg = market === 'cn' ? {
      name: '沪深300',
      oversold: 30,
      overbought: 75,
      rsiPeriod: 14,
      ddThreshold: [0.20, 0.15, 0.08],
    } : {
      name: '纳指100',
      oversold: 35,
      overbought: 70,
      rsiPeriod: 14,
      ddThreshold: [0.20, 0.15, 0.10],
    };

    const signals = computeSignals(candles, cfg);
    signals.market = market;
    res.status(200).json({ ok: true, data: signals });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, market });
  }
}

// ══════════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════════

function calcSMA(prices, period) {
  const r = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { r.push(null); continue; }
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += prices[j];
    r.push(s / period);
  }
  return r;
}

function calcEMA(prices, period) {
  const r = [prices[0]];
  const k = 2 / (period + 1);
  for (let i = 1; i < prices.length; i++) r.push(prices[i] * k + r[i - 1] * (1 - k));
  return r;
}

function calcMACD(prices) {
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine, 9);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
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

function calcBollinger(prices, period = 20, mult = 2) {
  const sma = calcSMA(prices, period);
  const upper = [], lower = [], width = [];
  for (let i = 0; i < prices.length; i++) {
    if (sma[i] === null) { upper.push(null); lower.push(null); width.push(null); continue; }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (prices[j] - sma[i]) ** 2;
    const std = Math.sqrt(sumSq / period);
    upper.push(sma[i] + mult * std);
    lower.push(sma[i] - mult * std);
    width.push((upper[i] - lower[i]) / sma[i] * 100);
  }
  return { upper, lower, width, sma };
}

// ══════════════════════════════════════════════
//  综合评分引擎
// ══════════════════════════════════════════════

function computeSignals(candles, cfg) {
  const prices = candles.map(c => c.close);
  const n = prices.length;
  const last = n - 1;
  const price = prices[last];
  const ath = Math.max(...prices);
  const { oversold, overbought, ddThreshold } = cfg;

  const sma10 = calcSMA(prices, 10);
  const sma20 = calcSMA(prices, 20);
  const sma50 = calcSMA(prices, Math.min(50, n));
  const sma200 = calcSMA(prices, Math.min(200, n));
  const rsi = calcRSI(prices, 14);
  const macd = calcMACD(prices);
  const boll = calcBollinger(prices);
  const volSMA = calcSMA(candles.map(c => c.volume || 0), 20);

  const roc5 = n > 5 ? price / prices[last - 5] - 1 : 0;

  let streak = 0;
  for (let i = last; i > 0; i--) {
    if (prices[i] >= prices[i - 1]) {
      if (streak >= 0) streak++;
      else break;
    } else {
      if (streak <= 0) streak--;
      else break;
    }
  }

  const sma10Val = sma10[last];
  const sma20Val = sma20[last];
  const sma50Val = sma50[last];
  const sma200Val = sma200[last];
  const rsiVal = rsi[last];
  const macdHist = macd.histogram[last];
  const macdLine = macd.macdLine[last];
  const macdSignal = macd.signalLine[last];
  const bollWidth = boll.width[last];
  const bollUpper = boll.upper[last];
  const bollLower = boll.lower[last];
  const curVol = candles[last]?.volume || 0;
  const avgVol = volSMA[last];
  const volRatio = avgVol > 0 ? curVol / avgVol : 1;

  const dist10 = sma10Val > 0 ? (price - sma10Val) / sma10Val : 0;
  const dist20 = sma20Val > 0 ? (price - sma20Val) / sma20Val : 0;
  const dist50 = sma50Val > 0 ? (price - sma50Val) / sma50Val : 0;
  const bollUpperDist = bollUpper > 0 ? (bollUpper - price) / bollUpper : 0;
  const bollLowerDist = bollLower > 0 ? (price - bollLower) / bollLower : 0;
  const dd = (price - ath) / ath;

  let score = 0;
  const allSignals = [];

  function addSignal(impact, text, weight) {
    allSignals.push({ impact, text, weight: Math.abs(weight) });
    if (impact === 'buy') score += weight;
    else if (impact === 'sell') score -= weight;
  }

  const os = oversold, ob = overbought;
  const [ddDeep, ddMid, ddLight] = ddThreshold;

  // ━━ 维度1: 趋势位置 ━━

  if (dist10 < -0.03) addSignal('buy', `跌破10周均线 ${(dist10*100).toFixed(1)}%`, 1.5);
  else if (dist10 < -0.01) addSignal('buy', `略低于10周均线`, 0.5);
  else if (dist10 > 0.05) addSignal('sell', `远离10周均线 ${(dist10*100).toFixed(1)}%`, 1);
  else addSignal('hold', `10周均线附近 ${(dist10*100).toFixed(1)}%`, 0);

  if (dist20 < -0.02) addSignal('buy', `跌破20周均线 ${(dist20*100).toFixed(1)}%`, 2);
  else if (dist20 < -0.005) addSignal('buy', `略低于20周均线`, 1);
  else if (dist20 > 0.08) addSignal('sell', `远离20周均线 ${(dist20*100).toFixed(1)}%`, 1.5);
  else if (dist20 > 0.03) addSignal('sell', `20周均线上方 ${(dist20*100).toFixed(1)}%`, 0.5);
  else addSignal('hold', `20周均线附近`, 0);

  if (dist50 !== null) {
    if (dist50 < -0.03) addSignal('buy', `跌破50周均线 ${(dist50*100).toFixed(1)}%`, 2);
    else if (dist50 < 0) addSignal('buy', `略低于50周均线`, 1);
    else if (dist50 > 0.12) addSignal('sell', `远离50周均线 ${(dist50*100).toFixed(1)}%`, 1);
    else addSignal('hold', `50周均线上方 ${(dist50*100).toFixed(1)}%`, 0);
  }

  // ━━ 维度2: 动能 ━━

  if (rsiVal !== null) {
    if (rsiVal < os - 5) addSignal('buy', `RSI ${rsiVal.toFixed(1)}，深度超卖`, 2.5);
    else if (rsiVal < os) addSignal('buy', `RSI ${rsiVal.toFixed(1)}，超卖区`, 2);
    else if (rsiVal < os + 5) addSignal('buy', `RSI ${rsiVal.toFixed(1)}，偏低`, 1);
    else if (rsiVal > ob + 5) addSignal('sell', `RSI ${rsiVal.toFixed(1)}，深度超买`, 2.5);
    else if (rsiVal > ob) addSignal('sell', `RSI ${rsiVal.toFixed(1)}，超买区`, 2);
    else if (rsiVal > 60) addSignal('sell', `RSI ${rsiVal.toFixed(1)}，偏高`, 0.5);
    else addSignal('hold', `RSI ${rsiVal.toFixed(1)}，中性`, 0);
  }

  const prevMacdHist = macd.histogram[last - 1];
  if (macdHist !== null && prevMacdHist !== null) {
    if (macdHist < 0 && macdHist > prevMacdHist) addSignal('buy', 'MACD绿柱缩短，空头减弱', 1);
    else if (macdHist < 0 && macdHist < prevMacdHist) addSignal('sell', 'MACD绿柱放大，空头增强', 1.5);
    else if (macdHist > 0 && macdHist < prevMacdHist) addSignal('sell', 'MACD红柱缩短，多头减弱', 1);
    else if (macdHist > 0 && macdHist > prevMacdHist) addSignal('buy', 'MACD红柱放大，多头增强', 1.5);
    else addSignal('hold', 'MACD零轴附近', 0);
  }

  if (roc5 < -0.08) addSignal('buy', `近5周跌 ${(roc5*100).toFixed(1)}%`, 1.5);
  else if (roc5 < -0.04) addSignal('buy', `近5周跌 ${(roc5*100).toFixed(1)}%`, 0.5);
  else if (roc5 > 0.08) addSignal('sell', `近5周涨 ${(roc5*100).toFixed(1)}%`, 1.5);
  else if (roc5 > 0.04) addSignal('sell', `近5周涨 ${(roc5*100).toFixed(1)}%`, 0.5);
  else addSignal('hold', `近5周 ${(roc5*100).toFixed(1)}%`, 0);

  // ━━ 维度3: 均值回归 ━━

  if (dd < -ddDeep) addSignal('buy', `从前高回撤 ${(dd*100).toFixed(1)}%，深度回调`, 2.5);
  else if (dd < -ddMid) addSignal('buy', `从前高回撤 ${(dd*100).toFixed(1)}%`, 2);
  else if (dd < -ddLight) addSignal('buy', `从前高回撤 ${(dd*100).toFixed(1)}%`, 1.5);
  else if (dd < -0.05) addSignal('hold', `小幅回撤 ${(dd*100).toFixed(1)}%`, 0);
  else addSignal('sell', `接近前高${(dd*100).toFixed(1)}%`, 1);

  if (bollLowerDist !== null && bollLowerDist < 0.01) addSignal('buy', '触及布林下轨', 2);
  else if (bollLowerDist !== null && bollLowerDist < 0.03) addSignal('buy', '接近布林下轨', 1);

  if (bollUpperDist !== null && bollUpperDist < 0.01) addSignal('sell', '触及布林上轨', 2);
  else if (bollUpperDist !== null && bollUpperDist < 0.03) addSignal('sell', '接近布林上轨', 1);

  const bollWidthHistory = boll.width.filter(w => w !== null);
  const avgBollWidth = bollWidthHistory.length ? bollWidthHistory.reduce((a, b) => a + b, 0) / bollWidthHistory.length : 1;
  const widthRatio = bollWidth != null ? bollWidth / avgBollWidth : 1;
  if (widthRatio < 0.6) addSignal('hold', '布林带宽收窄，变盘在即', 0);
  else if (widthRatio > 1.8) addSignal('hold', '布林带宽扩张，趋势延续', 0);

  // ━━ 维度4: 量价结构 ━━

  if (streak >= 5) addSignal('sell', `连涨 ${streak} 周`, 1.5);
  else if (streak >= 4) addSignal('sell', `连涨 ${streak} 周`, 1);
  else if (streak <= -5) addSignal('buy', `连跌 ${Math.abs(streak)} 周`, 1.5);
  else if (streak <= -4) addSignal('buy', `连跌 ${Math.abs(streak)} 周`, 1);
  else addSignal('hold', `连${streak > 0 ? '涨' : '跌'}${Math.abs(streak)}周`, 0);

  if (volRatio > 2 && roc5 < -0.03) addSignal('buy', `放量下跌 ${volRatio.toFixed(1)}x`, 1.5);
  else if (volRatio > 1.5 && roc5 < -0.02) addSignal('buy', `下跌放量 ${volRatio.toFixed(1)}x`, 1);
  else if (volRatio > 2 && roc5 > 0.03) addSignal('sell', `放量上涨 ${volRatio.toFixed(1)}x`, 1.5);
  else if (volRatio > 1.5 && roc5 > 0.02) addSignal('sell', `上涨放量 ${volRatio.toFixed(1)}x`, 0.5);
  else addSignal('hold', `量能 ${volRatio.toFixed(1)}x`, 0);

  if (sma200Val !== null && sma200Val > 0) {
    const dist200 = (price - sma200Val) / sma200Val;
    if (dist200 < 0) addSignal('buy', `在200周均线下方 ${(dist200*100).toFixed(1)}%`, 2);
  }

  // ── 决策 ──

  const buySignals = allSignals.filter(s => s.impact === 'buy').map(s => ({ text: s.text, weight: s.weight }));
  const sellSignals = allSignals.filter(s => s.impact === 'sell').map(s => ({ text: s.text, weight: s.weight }));
  const holdSignals = allSignals.filter(s => s.impact === 'hold').map(s => ({ text: s.text }));

  const totalScore = score;
  let overall, intensity;

  if (totalScore >= 8) { overall = 'BUY'; intensity = '⚡ 强烈加仓'; }
  else if (totalScore >= 5) { overall = 'BUY'; intensity = '📈 加仓'; }
  else if (totalScore >= 2) { overall = 'BUY'; intensity = '🌱 轻仓加注'; }
  else if (totalScore <= -8) { overall = 'SELL'; intensity = '🚨 强烈减仓'; }
  else if (totalScore <= -5) { overall = 'SELL'; intensity = '⚠️ 减仓/止盈'; }
  else if (totalScore <= -2) { overall = 'SELL'; intensity = '🔻 小幅减仓'; }
  else { overall = 'HOLD'; intensity = '⏸️ 持有/观望'; }

  return {
    name: cfg.name,
    price, overall, intensity, score: totalScore,
    signals: { buy: buySignals, sell: sellSignals, hold: holdSignals },
    indicators: {
      sma10: sma10Val, sma20: sma20Val, sma50: sma50Val, sma200: sma200Val,
      dist10, dist20, dist50,
      rsi: rsiVal,
      macdHistogram: macdHist, macdLine, macdSignal,
      bollWidth, bollUpper, bollLower,
      bollUpperDist, bollLowerDist,
      volRatio, streak, roc5, drawdown: dd, ath,
    },
    candles: candles.map((c, i) => ({
      t: c.date.toISOString().slice(0, 10),
      o: c.open, h: c.high, l: c.low,
      p: c.close, v: c.volume,
      sma20: sma20[i],
      bollU: boll.upper[i], bollL: boll.lower[i],
    })),
    lastTime: candles[last].date.toISOString(),
  };
}
