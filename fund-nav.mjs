/**
 * Vercel Serverless Function — /api/fund-nav?code=160213
 * 返回某只基金的实时净值/估值数据
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const code = req.query?.code?.trim();
  if (!code || code.length < 6) {
    return res.status(400).json({ ok: false, error: '请输入6位基金代码' });
  }

  try {
    const result = await fetchFundNav(code);
    res.status(200).json({ ok: true, data: result });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message, code });
  }
}

async function fetchFundNav(code) {
  // 通道1: 天天基金实时估值接口 (JSONP)
  try {
    const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Referer': 'https://fund.eastmoney.com/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error('status ' + resp.status);
    const text = await resp.text();
    // 返回格式: jsonpgz({"fundcode":"160213",...});
    const match = text.match(/jsonpgz\((.+)\)/);
    if (match) {
      const data = JSON.parse(match[1]);
      return {
        code: data.fundcode,
        name: data.name || '',
        navDate: data.jzrq || '',
        nav: data.dwjz ? parseFloat(data.dwjz) : null,
        estimated: data.gsz ? parseFloat(data.gsz) : null,
        estimatedChange: data.gszzl ? parseFloat(data.gszzl) : null,
        estimatedTime: data.gztime || '',
        source: 'eastmoney-estimate',
      };
    }
    throw new Error('解析失败');
  } catch (estErr) {
    // 通道2: 天天基金净值走势数据 (pingzhongdata)
    try {
      const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Referer': 'https://fund.eastmoney.com/' },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) throw new Error('status ' + resp.status);
      const text = await resp.text();

      // 解析Data_netWorthTrend
      let navData = [];
      const navMatch = text.match(/Data_netWorthTrend\s*=\s*(\[.+?\]);/s);
      if (navMatch) navData = JSON.parse(navMatch[1]);

      // 解析基金名称
      let fundName = '';
      const nameMatch = text.match(/Data_fundName\s*=\s*"(.+?)";/);
      if (nameMatch) fundName = nameMatch[1];

      if (navData.length > 0) {
        const latest = navData[navData.length - 1];
        const prev = navData.length > 1 ? navData[navData.length - 2] : null;
        const navValue = latest[1]; // unit NAV
        const prevNav = prev ? prev[1] : navValue;
        const change = prev && prevNav ? (navValue - prevNav) / prevNav * 100 : null;

        return {
          code,
          name: fundName,
          navDate: timestampToDate(latest[0]),
          nav: navValue,
          estimated: null,
          estimatedChange: null,
          latestNavChange: change,
          source: 'eastmoney-nav',
        };
      }
      throw new Error('无净值数据');
    } catch (navErr) {
      throw new Error('数据获取失败');
    }
  }
}

function timestampToDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
