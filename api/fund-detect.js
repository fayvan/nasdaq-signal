/**
 * Vercel Serverless Function — /api/fund-detect?code=160213
 * 自动识别基金类型：us（美股QDII）或 cn（国内A股）
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const code = req.query?.code?.trim();
  if (!code || code.length < 6) {
    return res.status(200).json({ ok: false, error: '请输入6位基金代码' });
  }

  try {
    const result = await detectFundType(code);
    res.status(200).json({ ok: true, data: result });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message, code });
  }
}

async function detectFundType(code) {
  // 通道1: 天天基金实时估值接口（仅国内基金有此数据）
  try {
    const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const text = await resp.text();
      const match = text.match(/jsonpgz\((.+)\)/);
      if (match) {
        const data = JSON.parse(match[1]);
        // 有实时估值 → 国内基金
        if (data.gsz !== undefined) {
          return {
            code,
            market: 'cn',
            name: data.name || '',
            source: 'eastmoney-estimate',
            confidence: 'high',
          };
        }
      }
    }
  } catch {}

  // 通道2: 天天基金净值数据（国内外都有）
  try {
    const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const text = await resp.text();

      // 提取基金名称
      let name = '';
      const nameMatch = text.match(/Data_fundName\s*=\s*"(.+?)";/);
      if (nameMatch) name = nameMatch[1];

      // 提取基金类型（如果名称包含 QDII 或 纳斯达克 等关键词）
      const nameLower = name.toLowerCase() + text.toLowerCase();
      const isQDII = /qdii|纳斯达克|标普|全球|海外|美国|纳指/i.test(nameLower);

      // 提取净值数据
      const navMatch = text.match(/Data_netWorthTrend\s*=\s*(\[.+?\]);/s);
      const hasNav = navMatch !== null;

      if (hasNav || name) {
        return {
          code,
          market: isQDII ? 'us' : 'cn',
          name: name || code,
          source: 'eastmoney-nav',
          confidence: isQDII ? 'high' : 'medium',
          detectedBy: isQDII ? 'keyword:QDII' : 'domestic-default',
        };
      }
    }
  } catch {}

  // 通道3: 无法识别
  return {
    code,
    market: 'us', // 默认归入美股（QDII）
    name: '',
    source: 'unknown',
    confidence: 'low',
  };
}
