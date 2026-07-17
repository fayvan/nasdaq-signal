/**
 * Vercel Serverless Function — /api/signals
 * 双市场差异化分析引擎
 * 新增：市场热度、情绪分析、机构行为推断
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  let market = 'us';
  try {
    const url = new URL(req.url, 'http://localhost');
    market = (url.searchParams.get('market') || 'us').toLowerCase();
    const code = (url.searchParams.get('code') || '').trim().toUpperCase();

    // 确定数据源代码
    let symbol;
    if (code) {
      // 个股模式
      if (market === 'cn') {
        // A股：沪市 6/9 开头 .SS，深市 0/3/2 开头 .SZ
        if (/^(6|9)/.test(code)) symbol = code + '.SS';
        else if (/^(0|3|2)/.test(code)) symbol = code + '.SZ';
        else symbol = code + '.SS';
      } else {
        symbol = code;
      }
    } else {
      symbol = market === 'cn' ? '000300.SS' : '%5ENDX';
    }
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2y&interval=1wk&includePrePost=false`;

    const resp = await fetch(chartUrl, {
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

    // VIX 数据（美股专用）
    const vixData = market !== 'cn' ? await fetchVIX().catch(() => null) : null;

    const signals = computeSignals(candles, market);
    signals.market = market;
    signals.vix = vixData;
    signals._version = 'v3.0-new-engine';
    // 标识是否个股模式
    if (code) {
      signals.name = code;
      signals.isStock = true;
      signals.analysisType = '个股分析';
    } else {
      signals.analysisType = market === 'cn' ? '沪深300指数分析' : '纳指100指数分析';
    }
    res.status(200).json({ ok: true, data: signals });
  } catch (err) {
    // catch 里绝对不能再抛异常
    try {
      res.status(200).json({ ok: false, error: err.message, market });
    } catch {
      res.status(200).json({ ok: false, error: 'unknown: ' + String(err.message) });
    }
  }
}

// ══════════════════════════════════
//  VIX 恐慌指数获取
// ══════════════════════════════════

async function fetchVIX() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=6mo&interval=1wk&includePrePost=false';
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error('VIX HTTP ' + resp.status);
  const json = await resp.json();
  if (!json.chart?.result?.length) return null;
  const r = json.chart.result[0];
  const ts = r.timestamp;
  const q = r.indicators.quote[0];
  const candles = ts.map((t, i) => ({ date: new Date(t * 1000), close: q.close[i] }))
    .filter(c => c.close !== null && c.close > 0)
    .sort((a, b) => a.date - b.date);
  const last = candles[candles.length - 1]?.close;
  if (!last) return null;
  // 计算VIX变化趋势（近4周 vs 前4周）
  const recent = candles.filter(c => c.date >= new Date(Date.now() - 28 * 86400000)).map(c => c.close);
  const older = candles.filter(c => c.date < new Date(Date.now() - 28 * 86400000) && c.date >= new Date(Date.now() - 56 * 86400000)).map(c => c.close);
  const avgRecent = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : last;
  const avgOlder = older.length ? older.reduce((a, b) => a + b, 0) / older.length : last;
  return { value: last, change: avgOlder > 0 ? (avgRecent - avgOlder) / avgOlder * 100 : 0 };
}

// ══════════════════════════════════
//  工具函数
// ══════════════════════════════════

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
  if (!prices.length) return [];
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

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  const atr = calcSMA(tr, period);
  return atr[atr.length - 1];
}

function calcSTDDEV(prices, period) {
  const r = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { r.push(null); continue; }
    const slice = prices.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    r.push(Math.sqrt(variance));
  }
  return r;
}

// ══════════════════════════════════════════════
//  综合分析引擎
// ══════════════════════════════════════════════

// 安全格式化：任何值都能转成 N 位小数，undefined/null 返回 '0'
function sf(v, n = 1) {
  return (v == null || isNaN(v) ? 0 : v).toFixed(n);
}

function computeSignals(candles, market) {
  const prices = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 1);
  const n = prices.length;
  const last = n - 1;
  const price = prices[last];
  const ath = Math.max(...prices);

  const isCN = market === 'cn';

  const cfg = isCN ? {
    name: '沪深300', oversold: 28, overbought: 72,
    strategy: '均值回归', ddDeep: 0.22, ddMid: 0.15, ddLight: 0.08,
    TM: 0.7, RM: 1.3, EXT: 0.15,
  } : {
    name: '纳指100', oversold: 35, overbought: 70,
    strategy: '趋势跟踪', ddDeep: 0.18, ddMid: 0.12, ddLight: 0.08,
    TM: 1.3, RM: 0.7, EXT: 0.10,
  };

  const { oversold: OS, overbought: OB, TM, RM, EXT, ddDeep, ddMid, ddLight } = cfg;

  // ── 基础指标 ──
  const sma10 = calcSMA(prices, 10);
  const sma20 = calcSMA(prices, 20);
  const sma50 = calcSMA(prices, Math.min(50, n));
  const sma120 = calcSMA(prices, Math.min(120, n));
  const sma200 = calcSMA(prices, Math.min(200, n));
  const rsi = calcRSI(prices, 14);
  const macd = calcMACD(prices);
  const boll = calcBollinger(prices);
  const atr = calcATR(candles, 14);
  const volSMA = calcSMA(volumes, 20);
  const stddev20 = calcSTDDEV(prices, 20);

  const roc5 = n > 5 ? price / prices[last - 5] - 1 : 0;
  const roc10 = n > 10 ? price / prices[last - 10] - 1 : 0;
  const roc20 = n > 20 ? price / prices[last - 20] - 1 : 0;

  // 连涨/跌
  let streak = 0;
  for (let i = last; i > 0; i--) {
    if (prices[i] >= prices[i - 1]) { if (streak >= 0) streak++; else break; }
    else { if (streak <= 0) streak--; else break; }
  }

  const sma10Val = sma10[last], sma20Val = sma20[last], sma50Val = sma50[last];
  const sma120Val = sma120[last], sma200Val = sma200[last];
  const rsiVal = rsi[last];
  const macdHist = macd.histogram[last];
  const prevMacdHist = macd.histogram[last - 1];
  const macdLine = macd.macdLine[last];
  const macdSignal = macd.signalLine[last];
  const bollWidth = boll.width[last], bollUpper = boll.upper[last], bollLower = boll.lower[last];
  const curVol = volumes[last];
  const avgVol = volSMA[last];
  const volRatio = avgVol > 0 ? curVol / avgVol : 1;
  const dist10 = sma10Val > 0 ? (price - sma10Val) / sma10Val : 0;
  const dist20 = sma20Val > 0 ? (price - sma20Val) / sma20Val : 0;
  const dist50 = sma50Val > 0 ? (price - sma50Val) / sma50Val : 0;
  const dist120 = sma120Val > 0 ? (price - sma120Val) / sma120Val : null;
  const dist200 = sma200Val > 0 ? (price - sma200Val) / sma200Val : null;
  const bollUpperDist = bollUpper > 0 ? (bollUpper - price) / bollUpper : 0;
  const bollLowerDist = bollLower > 0 ? (price - bollLower) / bollLower : 0;
  const dd = (price - ath) / ath;
  const atrPct = price > 0 && atr !== null ? atr / price * 100 : 0;
  const stddevPct = price > 0 && stddev20[last] !== null ? stddev20[last] / price * 100 : 0;

  // ── 评分引擎 ──
  let score = 0;
  const allSignals = [];

  function add(impact, text, weight) {
    const w = Math.abs(weight);
    allSignals.push({ impact, text, weight: w });
    if (impact === 'buy') score += w; else if (impact === 'sell') score -= w;
  }

  // ━━ 趋势 ━━
  if (dist10 < -EXT) add('buy', `跌破10周均线 ${sf(dist10*100)}%`, 1.5 * RM);
  else if (dist10 < -0.01) add('buy', `略低于10周均线`, 0.5 * RM);
  else if (dist10 > EXT + 0.03) add('sell', `远离10周均线 ${sf(dist10*100)}%`, 1.5 * TM);
  else add('hold', `10周均线附近 ${sf(dist10*100)}%`, 0);

  if (dist20 < -EXT * 0.8) add('buy', `跌破20周均线 ${sf(dist20*100)}%`, 2 * RM);
  else if (dist20 < -0.005) add('buy', `略低于20周均线`, 1 * RM);
  else if (dist20 > EXT * 0.8) add('sell', `远离20周均线 ${sf(dist20*100)}%`, 2 * TM);
  else add('hold', `20周均线附近`, 0);

  if (dist50 !== null) {
    if (dist50 < -EXT * 0.6) add('buy', `跌破50周均线 ${sf(dist50*100)}%`, 2.5 * RM);
    else if (dist50 < 0) add('buy', `略低于50周均线`, 1 * RM);
    else if (dist50 > EXT * 0.8 + 0.05) add('sell', `远离50周均线 ${sf(dist50*100)}%`, 1.5 * TM);
    else add('hold', `50周均线附近`, 0);
  }

  // ━━ 动能 ━━
  if (rsiVal !== null) {
    if (rsiVal < OS - 5) add('buy', `RSI ${sf(rsiVal)}，深度超卖`, 3 * RM);
    else if (rsiVal < OS) add('buy', `RSI ${sf(rsiVal)}，超卖区`, 2 * RM);
    else if (rsiVal < OS + 5) add('buy', `RSI ${sf(rsiVal)}，偏低`, 1);
    else if (rsiVal > OB + 5) add('sell', `RSI ${sf(rsiVal)}，深度超买`, 3);
    else if (rsiVal > OB) add('sell', `RSI ${sf(rsiVal)}，超买区`, 2);
    else if (rsiVal > 65) add('sell', `RSI ${sf(rsiVal)}，偏高`, 1);
    else add('hold', `RSI ${sf(rsiVal)}，中性区`, 0);
  }

  // ━━ 均值回归 ━━
  if (dd < -ddDeep) add('buy', `从前高回撤 ${sf(dd*100)}%，深度回调区`, 3 * RM);
  else if (dd < -ddMid) add('buy', `从前高回撤 ${sf(dd*100)}%`, 2 * RM);
  else if (dd < -ddLight) add('buy', `从前高回撤 ${sf(dd*100)}%`, 1.5 * RM);
  else if (dd < -0.05) add('hold', `小幅回撤 ${sf(dd*100)}%`, 0);
  else add('sell', `接近前高(${sf(dd*100)}%)`, 1.5 * TM);

  // ━━ 量价结构 ━━
  if (bollLowerDist !== null && bollLowerDist < 0.01) add('buy', '触及布林下轨', 2.5 * RM);
  else if (bollLowerDist < 0.03) add('buy', '接近布林下轨', 1 * RM);
  if (bollUpperDist !== null && bollUpperDist < 0.01) add('sell', '触及布林上轨', 2.5);
  else if (bollUpperDist < 0.03) add('sell', '接近布林上轨', 1);

  if (streak >= 6) add('sell', `连涨 ${streak} 周`, 2.5);
  else if (streak >= 5) add('sell', `连涨 ${streak} 周`, 1.5);
  else if (streak >= 4) add('sell', `连涨 ${streak} 周`, 1);
  else if (streak <= -6) add('buy', `连跌 ${Math.abs(streak)} 周，极端超卖`, 2.5 * RM);
  else if (streak <= -5) add('buy', `连跌 ${Math.abs(streak)} 周`, 1.5 * RM);
  else if (streak <= -4) add('buy', `连跌 ${Math.abs(streak)} 周`, 1 * RM);

  if (volRatio > 2.5 && roc5 < -0.02) add('buy', `巨量下跌(${sf(volRatio)}x)`, 2 * RM);
  else if (volRatio > 2.5 && roc5 > 0.02) add('sell', `巨量上涨(${sf(volRatio)}x)`, 2);
  else if (volRatio < 0.5) add('hold', `严重缩量(${sf(volRatio)}x)`, 0);

  // ══════════════════════════════════════════════
  //  综合安全边际分析（融合价值投资与周期框架）
  // ══════════════════════════════════════════════

  // 核心逻辑：价格 vs 价值的偏离程度决定安全边际
  // 当价格远超均线系统时安全边际消失，触发卖出信号
  if (dist20 > 0.15) add('sell', `价格远超20周均线${sf(dist20*100)}%，安全边际大幅收窄`, 3);
  else if (dist20 > 0.10) add('sell', `价格偏离20周均线${sf(dist20*100)}%，安全边际不足`, 2);

  // 长期偏离程度：50周均线反映更长周期的价值锚
  if (dist50 > 0.20) add('sell', `较50周均线溢价${sf(dist50*100)}%，长期估值偏高`, 2.5);
  else if (dist50 > 0.15) add('sell', `较50周均线溢价${sf(dist50*100)}%，进入高估区间`, 1.5);

  // 盈利质量预警：价格与成交量的背离信号
  // 放量下跌=市场对基本面恶化提前反应
  if (roc10 < -0.08 && volRatio > 1.5) add('sell', `中期下跌${sf(roc10*100)}%伴随放量，资金主动离场`, 2.5);
  if (roc10 > 0.15 && volRatio > 2) add('sell', `短期暴涨${sf(roc10*100)}%且成交异常放大，过热风险`, 2);

  // 价格上涨但成交量萎缩 = 上涨动力衰竭
  const priceUp = roc5 > 0;
  const volShrink = volRatio < 0.6;
  if (priceUp && volShrink) add('sell', `量价背离：价格上涨但成交萎缩，上涨动力不足`, 1.5);

  // 基于康波周期的宏观定位
  // 不同周期阶段采用不同的估值容忍度
  const currentYear = new Date().getFullYear();
  if (currentYear >= 2015 && currentYear < 2025) {
    // 萧条期：保守策略，严格控制仓位
    if (roc20 > 0.10) add('sell', `周期定位偏保守（康波萧条期），反弹${sf(roc20*100)}%建议减仓`, 2.5);
    if (dist20 > 0.05) add('sell', `宏观环境偏弱，高于均线${sf(dist20*100)}%建议控制仓位`, 1.5);
  } else if (currentYear >= 2025 && currentYear < 2035) {
    // 回升期：适度放宽，但仍需警惕过热
    if (roc20 > 0.30) add('sell', `周期回升期涨幅${sf(roc20*100)}%已偏高，注意回调风险`, 2);
    if (roc5 > 0.10 && volRatio < 0.7) add('sell', `短期急涨${sf(roc5*100)}%但量能不足，有回调需求`, 1.5);
  }

  // 卖出信号共振加强
  const totalSellWeight = allSignals.filter(s => s.impact === 'sell').reduce((a, s) => a + s.weight, 0);
  if (totalSellWeight > 10) add('sell', `多个卖出信号共振（综合强度${sf(totalSellWeight)}），建议大幅减仓`, 2);

  // ══════════════════════════════════════════════
  //  市场热度分析（Sentiment / Heat）
  // ══════════════════════════════════════════════

  const heatIndicators = {};

  // 1. 成交量热度：当前量能相对历史水平
  const volPercentile = (() => {
    const sorted = [...volumes].sort((a, b) => a - b);
    const rank = sorted.indexOf(curVol);
    return rank > 0 ? Math.round(rank / sorted.length * 100) : 50;
  })();

  // 2. 波动率热度（ATR%历史百分位）
  const atrHistory = [];
  for (let i = 20; i < prices.length; i++) {
    const sub = candles.slice(i - 14, i);
    const a = calcATR(sub, 14);
    if (a !== null && prices[i] > 0) atrHistory.push(a / prices[i] * 100);
  }
  const atrSorted = [...atrHistory].sort((a, b) => a - b);
  const atrRank = atrSorted.indexOf(atrPct);
  const atrPercentile = atrRank >= 0 ? Math.round(atrRank / atrSorted.length * 100) : 50;

  // 3. 布林带宽热度（宽=趋势，窄=震荡）
  const bollWidthHistory = boll.width.filter(w => w !== null);
  const avgBW = bollWidthHistory.length ? bollWidthHistory.reduce((a, b) => a + b, 0) / bollWidthHistory.length : 1;
  const bollWidthDev = bollWidth != null ? (bollWidth - avgBW) / avgBW : 0;

  // 4. 买卖力量比（基于信号数量 + K线实体比例）
  const buySigCount = allSignals.filter(s => s.impact === 'buy').length;
  const sellSigCount = allSignals.filter(s => s.impact === 'sell').length;
  const totalSigCount = buySigCount + sellSigCount || 1;
  const powerRatio = buySigCount / totalSigCount; // >0.5 = 多头占优

  // 5. K线实体分析（最近5周）
  let bullCandles = 0, bearCandles = 0;
  let avgBodyRatio = 0;
  for (let i = Math.max(0, last - 4); i <= last; i++) {
    const body = Math.abs(candles[i].close - candles[i].open);
    const range = candles[i].high - candles[i].low || 1;
    avgBodyRatio += body / range;
    if (candles[i].close > candles[i].open) bullCandles++;
    else bearCandles++;
  }
  avgBodyRatio /= 5;

  heatIndicators.volPercentile = volPercentile;
  heatIndicators.atrPercentile = atrPercentile;
  heatIndicators.bollWidthDev = bollWidthDev;
  heatIndicators.bullBearRatio = bullCandles + bearCandles > 0 ? bullCandles / (bullCandles + bearCandles) : 0.5;
  heatIndicators.powerRatio = powerRatio;
  heatIndicators.avgBodyRatio = avgBodyRatio;

  // 综合热度评分 0~100
  const heatScore = (() => {
    // 量能热度 (0~25)
    let s = (volPercentile / 100) * 25;
    // 波动热度 (0~25)
    s += (atrPercentile / 100) * 25;
    // 趋势热度 (0~25)
    s += Math.min(25, Math.abs(bollWidthDev) * 25);
    // 买卖力量 (0~25)
    s += (powerRatio * 50); // 0.5→25, 0.8→40 截断到25
    return Math.min(100, Math.round(s));
  })();

  // ══════════════════════════════════════════════
  //  情绪分析（Sentiment）
  // ══════════════════════════════════════════════

  // 1. 恐慌/贪婪指数（基于多因子）
  const greedScore = (() => {
    let g = 50;
    // RSI贡献
    if (rsiVal !== null) g += (rsiVal - 50) * 0.5;
    // ROC5贡献
    g += Math.max(-15, Math.min(15, roc5 * 100));
    // 回撤贡献
    g += Math.max(-10, Math.min(10, -dd * 100));
    // 连涨跌贡献
    g += Math.max(-15, Math.min(15, streak * 2));
    return Math.max(0, Math.min(100, Math.round(g)));
  })();

  // 2. 市场情绪分类
  let sentimentLabel, sentimentIcon;
  if (greedScore >= 80) { sentimentLabel = '极度贪婪'; sentimentIcon = '🔥'; }
  else if (greedScore >= 65) { sentimentLabel = '贪婪'; sentimentIcon = '😊'; }
  else if (greedScore >= 45) { sentimentLabel = '中性'; sentimentIcon = '😐'; }
  else if (greedScore >= 30) { sentimentLabel = '恐惧'; sentimentIcon = '😰'; }
  else { sentimentLabel = '极度恐惧'; sentimentIcon = '💀'; }

  // 3. 动量背离检测
  let divergence = '无';
  if (macdHist !== null && prevMacdHist !== null) {
    const priceUp = prices[last] > prices[last - 1] && prices[last] > prices[last - 2];
    const macdDown = macdHist < prevMacdHist;
    const priceDown = prices[last] < prices[last - 1] && prices[last] < prices[last - 2];
    const macdUp = macdHist > prevMacdHist;
    if (priceUp && macdDown) divergence = '顶背离（价格新高，MACD未跟，警惕回调）';
    else if (priceDown && macdUp) divergence = '底背离（价格新低，MACD回升，可能反转）';
  }

  // 4. 宽基指标（上涨/下跌比例）
  // 近似：比较当前价格与10周前的相对位置
  let advanceDecline = 0;
  for (let i = 0; i < 10; i++) {
    const idx = last - i * 5;
    if (idx > 0) advanceDecline += prices[idx] > prices[idx - 5] ? 1 : -1;
  }
  const adLabel = advanceDecline > 3 ? '强势' : advanceDecline > 0 ? '偏强' : advanceDecline > -3 ? '偏弱' : '弱势';

  // ══════════════════════════════════════════════
  //  机构行为推断（Institutional Flow Proxy）
  // ══════════════════════════════════════════════

  // 真实的机构持仓数据需要专门API，这里用量价行为推断
  let instFlowLabel = '中性';
  let instFlowDetail = [];

  // 1. 大单跟踪 proxy：异常放量 + 正向收盘 → 机构主动买入
  const bigCandleThreshold = 1.8;
  let recentBigBuy = 0, recentBigSell = 0;
  for (let i = Math.max(0, last - 8); i <= last; i++) {
    const vRatio = avgVol > 0 ? volumes[i] / avgVol : 1;
    if (vRatio > bigCandleThreshold) {
      const body = candles[i].close - candles[i].open;
      if (body > 0 && body / (candles[i].high - candles[i].low || 1) > 0.5) {
        recentBigBuy++;
        if (i === last) instFlowDetail.push('本周出现放量阳线，疑似机构主动买入');
      } else if (body < 0 && Math.abs(body) / (candles[i].high - candles[i].low || 1) > 0.5) {
        recentBigSell++;
        if (i === last) instFlowDetail.push('本周出现放量阴线，疑似机构主动卖出');
      }
    }
  }

  // 2. 持续吸筹/派发检测（Chaikin Money Flow proxy）
  // 累计: (close - low) - (high - close) / (high - low) * volume
  let cmfValue = 0;
  for (let i = Math.max(0, last - 10); i <= last; i++) {
    const hl = candles[i].high - candles[i].low || 1;
    const mfm = ((candles[i].close - candles[i].low) - (candles[i].high - candles[i].close)) / hl;
    cmfValue += mfm * volumes[i];
  }
  const instFlowScore = cmfValue > 0 ? Math.min(100, Math.round(cmfValue / (avgVol * 10) * 50 + 50))
    : Math.max(0, Math.round(50 - Math.abs(cmfValue) / (avgVol * 10) * 50));

  // 3. 机构买卖净额
  const instNet = recentBigBuy - recentBigSell;
  if (instNet > 1) { instFlowLabel = '机构净买入'; instFlowDetail.unshift(`近5周出现${recentBigBuy}次机构级买入信号`); }
  else if (instNet < -1) { instFlowLabel = '机构净卖出'; instFlowDetail.unshift(`近5周出现${recentBigSell}次机构级卖出信号`); }
  else { instFlowLabel = '无明显机构动作'; instFlowDetail.push('近期量价无异常，机构行为不明显'); }

  // ══════════════════════════════════════════════
  //  执行评分
  // ══════════════════════════════════════════════

  const buyList = allSignals.filter(s => s.impact === 'buy').map(s => ({ text: s.text, weight: s.weight }));
  const sellList = allSignals.filter(s => s.impact === 'sell').map(s => ({ text: s.text, weight: s.weight }));
  const holdList = allSignals.filter(s => s.impact === 'hold').map(s => ({ text: s.text }));

  const totalScore = score;

  let overall, intensity;
  if (totalScore >= 8) { overall = 'BUY'; intensity = '⚡ 强烈加仓'; }
  else if (totalScore >= 5) { overall = 'BUY'; intensity = '📈 加仓'; }
  else if (totalScore >= 2) { overall = 'BUY'; intensity = '🌱 轻仓加注'; }
  else if (totalScore <= -8) { overall = 'SELL'; intensity = '🚨 强烈减仓'; }
  else if (totalScore <= -5) { overall = 'SELL'; intensity = '⚠️ 减仓/止盈'; }
  else if (totalScore <= -2) { overall = 'SELL'; intensity = '🔻 小幅减仓'; }
  else { overall = 'HOLD'; intensity = '⏸️ 持有/观望'; }

  // ══════════════════════════════════════════════
  //  综合解读
  // ══════════════════════════════════════════════

  function generateSummary() {
    const numBuy = buyList.length, numSell = sellList.length;
    const rsiDesc = rsiVal !== null
      ? (rsiVal < 30 ? 'RSI深度超卖，市场恐慌' : rsiVal < 35 ? 'RSI处于超卖区' : rsiVal < 40 ? 'RSI偏低' :
         rsiVal > 75 ? 'RSI深度超买，市场亢奋' : rsiVal > 70 ? 'RSI处于超买区' : rsiVal > 65 ? 'RSI偏高，情绪偏热' :
         rsiVal > 55 ? 'RSI中性偏强' : rsiVal > 45 ? 'RSI中性' : 'RSI中性偏弱')
      : 'RSI无数据';
    const trendDesc = dist20 < -0.02 ? '明显跌破20周均线' : dist20 < 0 ? '略低于20周均线' :
      dist20 < 0.03 ? '围绕20周均线震荡' : dist20 < 0.08 ? '在20周均线上方运行' : '大幅远离20周均线';

    const volDesc = volRatio > 2.5 ? '成交量异常放大' : volRatio > 1.5 ? '成交量偏大' :
      volRatio < 0.5 ? '成交量极度萎缩' : '成交量正常';

    // 安全边际分析
    let marginDesc = '';
    if (dist20 > 0.15) marginDesc = '安全边际薄弱，估值偏高';
    else if (dist20 > 0.08) marginDesc = '安全边际不足，需注意估值风险';
    else if (dist20 < -0.10) marginDesc = '安全边际较厚，估值有吸引力';
    else if (dist20 < -0.05) marginDesc = '安全边际充足，具备一定投资价值';
    else marginDesc = '估值与安全边际处于合理区间';

    // 周期定位
    const currentYear = new Date().getFullYear();
    let cycleDesc = '';
    if (currentYear >= 2015 && currentYear < 2025) cycleDesc = '康波周期处于第五波萧条期末段';
    else if (currentYear >= 2025 && currentYear < 2035) cycleDesc = '第六次康波回升期，AI/新能源驱动新周期';

    let verdict;
    if (overall === 'BUY') {
      if (totalScore >= 8) verdict = '🚀 多维度共振强烈，市场存在低估机会，是较好的中长期布局窗口';
      else if (totalScore >= 5) verdict = '📈 多个买入信号触发，市场估值有吸引力，建议分批建仓';
      else verdict = '🌱 出现轻度买入信号，可关注但不急于重仓';
    } else if (overall === 'SELL') {
      if (totalScore <= -8) verdict = '🚨 市场出现过热特征，建议大幅减仓等待回调';
      else if (totalScore <= -5) verdict = '⚠️ 卖出信号增加，建议逐步降低仓位锁定利润';
      else verdict = '🔻 出现轻度卖出信号，可小幅减仓';
    } else {
      const bal = numBuy > numSell ? '买入信号略多于卖出信号，多头略占优势' :
        numSell > numBuy ? '卖出信号略多于买入信号，空头略占优势' : '多空信号均衡，市场方向不明确';
      verdict = `⏸️ ${bal}，建议观望或维持现有定投节奏`;
    }

    return {
      text: `${cfg.name}当前${trendDesc}，${rsiDesc}。${marginDesc}。${volDesc}，市场情绪${sentimentLabel}（${greedScore}分）。`,
      verdict,
      environment: cycleDesc || '震荡行情',
      risk: isCN && atrPct > 4 ? '高波动' : '正常波动',
      scoreBreakdown: `买入信号${numBuy}个，卖出信号${numSell}个，综合得分${totalScore >= 0 ? '+' : ''}${sf(totalScore)}`,
    };
  }

  return {
    name: cfg.name,
    strategy: cfg.strategy,
    price, overall, intensity, score: totalScore,
    summary: generateSummary(),

    // ── 新增：市场情绪分析 ──
    sentiment: {
      greedIndex: greedScore,
      label: sentimentLabel,
      icon: sentimentIcon,
      divergence,
      advanceDecline: { value: advanceDecline, label: adLabel },
      greedFactors: {
        rsi: rsiVal,
        momentum: roc5 * 100,
        drawdownFactor: -dd * 100,
        streakFactor: streak * 2,
      },
      heatIndex: heatScore,
      heatFactors: {
        volumePercentile: volPercentile,
        volatilityPercentile: atrPercentile,
        bollingerWidthDeviation: bollWidthDev,
        buyPowerRatio: powerRatio,
        bullCandleRatio: heatIndicators.bullBearRatio,
      },
    },

    // ── 新增：机构走向分析 ──
    institutional: {
      flowLabel: instFlowLabel,
      flowScore: instFlowScore,
      details: instFlowDetail,
      bigBuyCount: recentBigBuy,
      bigSellCount: recentBigSell,
      cmfNet: cmfValue,
      netPosition: instNet,
      // 基于量价的机构参与度
      participation: volPercentile > 70 ? '高' : volPercentile > 40 ? '中' : '低',
    },

    signals: { buy: buyList, sell: sellList, hold: holdList },
    indicators: {
      sma10: sma10Val, sma20: sma20Val, sma50: sma50Val, sma120: sma120Val, sma200: sma200Val,
      dist10, dist20, dist50,
      rsi: rsiVal,
      macdHistogram: macdHist, macdLine, macdSignal,
      bollWidth, bollUpper, bollLower,
      bollUpperDist, bollLowerDist,
      volRatio, streak, roc5, roc10, roc20,
      drawdown: dd, ath,
      atr: atr, atrPercent: atrPct,
      stddev: stddevPct,
      ad: advanceDecline,
    },
    candles: candles.map((c, i) => ({
      t: c.date.toISOString().slice(0, 10),
      o: c.open, h: c.high, l: c.low, p: c.close, v: c.volume,
      sma20: sma20[i],
      bollU: boll.upper[i], bollL: boll.lower[i],
    })),
    lastTime: candles[last].date.toISOString(),
  };
}
