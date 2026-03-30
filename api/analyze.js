// Content Grader API v3.0 â Expanded 32-signal analysis engine
// Orchestrates: Firecrawl + DataForSEO + OpenAI + PageSpeed Insights + Google NLP
// Signal architecture mapped to Google Content Warehouse API (seo-datawarehouse.com)

const { OpenAI } = require("openai");

// ============================================================================
// CORS handler
// ============================================================================
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ============================================================================
// Firecrawl: Scrape target URL
// ============================================================================
async function scrapeUrl(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not set");

  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      url,
      formats: ["markdown", "html"],
      onlyMainContent: true,
      includeTags: ["h1", "h2", "h3", "h4", "h5", "h6", "p", "table", "img", "a", "blockquote", "ul", "ol", "li", "schema", "script"],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Firecrawl error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  if (!data.success) throw new Error(`Firecrawl failed: ${JSON.stringify(data)}`);
  return data.data;
}

// ============================================================================
// SerpApi: Real Google rank lookup (actual SERP position)
// ============================================================================
async function getRealGoogleRank(keyword, targetUrl) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.warn("[SerpApi] SERPAPI_KEY not set â skipping real rank lookup");
    return null;
  }

  try {
    const targetDomain = extractDomain(targetUrl);
    const params = new URLSearchParams({
      engine: "google",
      q: keyword,
      api_key: apiKey,
      num: "100",
      gl: "ca",
      hl: "en",
    });

    const resp = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!resp.ok) {
      console.warn(`[SerpApi] HTTP ${resp.status} â skipping`);
      return null;
    }

    const data = await resp.json();
    const organicResults = data.organic_results || [];

    // Find the target URL in results (match by domain or exact URL)
    let realRank = null;
    let matchedUrl = null;
    let matchType = null;

    for (let i = 0; i < organicResults.length; i++) {
      const result = organicResults[i];
      const resultDomain = extractDomain(result.link || "");

      // Exact URL match (strongest)
      if (result.link && (result.link === targetUrl || result.link === targetUrl.replace(/\/$/, "") || result.link === targetUrl + "/")) {
        realRank = result.position || i + 1;
        matchedUrl = result.link;
        matchType = "exact_url";
        break;
      }

      // Domain match (fallback)
      if (resultDomain === targetDomain && !realRank) {
        realRank = result.position || i + 1;
        matchedUrl = result.link;
        matchType = "domain";
      }
    }

    // Check if page is beyond the first 100 results
    const totalResults = data.search_information?.total_results || null;

    console.log(`[SerpApi] Real rank for "${keyword}": ${realRank || "not in top 100"} (match: ${matchType || "none"})`);

    return {
      realRank,
      matchedUrl,
      matchType,
      totalResults,
      resultsChecked: organicResults.length,
      serpApiCreditsUsed: 1,
      searchEngine: "google",
      location: "Canada",
    };
  } catch (err) {
    console.warn("[SerpApi] Error:", err.message);
    return null;
  }
}

// ============================================================================
// DataForSEO: SERP results + competitor data
// ============================================================================
async function getSerpResults(keyword) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error("DataForSEO credentials not set");

  const auth = Buffer.from(`${login}:${password}`).toString("base64");

  const serpResp = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify([{
      keyword,
      location_code: 2840,
      language_code: "en",
      depth: 20,
    }]),
  });

  if (!serpResp.ok) throw new Error(`DataForSEO SERP error: ${serpResp.status}`);
  const serpData = await serpResp.json();

  let organicResults = [];
  let peopleAlsoAsk = [];
  let featuredSnippet = null;
  let serpFeatures = [];

  if (serpData.tasks?.[0]?.result?.[0]?.items) {
    const items = serpData.tasks[0].result[0].items;
    organicResults = items
      .filter((i) => i.type === "organic")
      .slice(0, 15)
      .map((item, idx) => ({
        rank: item.rank_absolute || idx + 1,
        domain: extractDomain(item.url),
        url: item.url,
        title: item.title,
        description: item.description,
      }));

    peopleAlsoAsk = items
      .filter((i) => i.type === "people_also_ask")
      .flatMap((i) => i.items || [])
      .map((q) => ({ question: q.title || q.question || "", answered: false }));

    // Extract featured snippet if present
    const fSnippet = items.find((i) => i.type === "featured_snippet");
    if (fSnippet) {
      featuredSnippet = {
        domain: extractDomain(fSnippet.url || ""),
        title: fSnippet.title || "",
        description: fSnippet.description || "",
      };
    }

    // Catalog all SERP feature types present
    const featureTypes = new Set(items.map((i) => i.type));
    serpFeatures = [...featureTypes];
  }

  // Extract search volume and keyword data if available
  const searchInfo = serpData.tasks?.[0]?.result?.[0] || {};

  return { organicResults, peopleAlsoAsk, featuredSnippet, serpFeatures, searchInfo };
}

async function getDomainMetrics(domains) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  const auth = Buffer.from(`${login}:${password}`).toString("base64");

  const blResp = await fetch("https://api.dataforseo.com/v3/backlinks/summary/live", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(domains.slice(0, 15).map((d) => ({ target: d }))),
  });

  let domainRanks = {};

  if (blResp.ok) {
    const blData = await blResp.json();
    if (blData.tasks) {
      blData.tasks.forEach((task) => {
        if (task.result?.[0]) {
          const r = task.result[0];
          domainRanks[r.target] = {
            rank: r.rank || 0,
            backlinks: r.backlinks || 0,
            referringDomains: r.referring_domains || 0,
            referringDomainsNofollow: r.referring_domains_nofollow || 0,
            brokenBacklinks: r.broken_backlinks || 0,
            referringIps: r.referring_ips || 0,
            referringSubnets: r.referring_subnets || 0,
          };
        }
      });
    }
  }

  return domainRanks;
}

// ============================================================================
// PageSpeed Insights: Core Web Vitals + Performance
// Maps to: CompressedQualitySignals, CrawlerChangerate (10/10 & 9/10 impact)
// ============================================================================
async function getPageSpeedData(url) {
  const apiKey = process.env.GOOGLE_API_KEY;
  // PageSpeed API works without a key (lower quota) or with one (higher quota)
  const keyParam = apiKey ? `&key=${apiKey}` : "";

  try {
    const resp = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=seo&category=accessibility${keyParam}`,
      { signal: AbortSignal.timeout(15000) }
    );

    if (!resp.ok) {
      console.warn(`[PageSpeed] API error ${resp.status}, using defaults`);
      return null;
    }

    const data = await resp.json();
    const crux = data.loadingExperience?.metrics || {};
    const lighthouse = data.lighthouseResult || {};
    const audits = lighthouse.audits || {};
    const categories = lighthouse.categories || {};

    return {
      // Core Web Vitals (CrUX real-user data)
      lcp: crux.LARGEST_CONTENTFUL_PAINT_MS?.percentile || null,
      lcpCategory: crux.LARGEST_CONTENTFUL_PAINT_MS?.category || "AVERAGE",
      cls: crux.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile ? crux.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null,
      clsCategory: crux.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category || "AVERAGE",
      inp: crux.INTERACTION_TO_NEXT_PAINT?.percentile || null,
      inpCategory: crux.INTERACTION_TO_NEXT_PAINT?.category || "AVERAGE",
      fcp: crux.FIRST_CONTENTFUL_PAINT_MS?.percentile || null,

      // Lighthouse scores
      performanceScore: categories.performance?.score || null,
      seoScore: categories.seo?.score || null,
      accessibilityScore: categories.accessibility?.score || null,

      // Specific audit results
      speedIndex: audits["speed-index"]?.numericValue || null,
      tbt: audits["total-blocking-time"]?.numericValue || null,
      isHttps: audits["is-on-https"]?.score === 1,
      hasViewport: audits["viewport"]?.score === 1,
      fontDisplay: audits["font-display"]?.score || 0,
      imageOptimization: audits["uses-optimized-images"]?.score || null,
      textCompression: audits["uses-text-compression"]?.score || null,
      renderBlocking: audits["render-blocking-resources"]?.numericValue || null,
      domSize: audits["dom-size"]?.numericValue || null,
      serverResponseTime: audits["server-response-time"]?.numericValue || null,

      // Mobile-friendliness indicators
      tapTargets: audits["tap-targets"]?.score || null,
      fontSizes: audits["font-size"]?.score || null,
    };
  } catch (err) {
    console.warn(`[PageSpeed] Failed: ${err.message}`);
    return null;
  }
}

// ============================================================================
// Google Cloud NLP: Entity Analysis
// Maps to: RepositoryWebref, QualitySalient (7/10 & 8/10 impact)
// ============================================================================
async function analyzeEntitiesWithNLP(text) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn("[NLP] No GOOGLE_API_KEY, skipping entity analysis");
    return null;
  }

  try {
    // Truncate text to stay within API limits (max ~1MB, but we keep it reasonable)
    const truncated = text.substring(0, 10000);

    const resp = await fetch(
      `https://language.googleapis.com/v1/documents:analyzeEntities?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: { type: "PLAIN_TEXT", content: truncated },
          encodingType: "UTF8",
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!resp.ok) {
      console.warn(`[NLP] API error ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const entities = (data.entities || []).map((e) => ({
      name: e.name,
      type: e.type,
      salience: e.salience || 0,
      mentions: e.mentions?.length || 0,
      hasWikipedia: !!e.metadata?.wikipedia_url,
      mid: e.metadata?.mid || null,
    }));

    // Sort by salience
    entities.sort((a, b) => b.salience - a.salience);

    // Compute entity metrics
    const totalSalience = entities.reduce((s, e) => s + e.salience,
NÂÛÛÝÛÝÛYÙQÜ\[]Y\ÈH[]Y\Ë[\
JHOKZY
NÂÛÛÝ[]U\\ÈH]ÈÙ]
[]Y\ËX\

JHOK\JJNÂ]\Â[]Y\Î[]Y\ËÛXÙJ
KÝ[[]Y\Î[]Y\Ë[ÝÛÝÛYÙQÜ\ÛÝ[ÛÝÛYÙQÜ\[]Y\Ë[Ý[]U\PÛÝ[[]U\\ËÚ^K[]U\\ÎË[]U\\×KÜ[]N[]Y\ÖÌH[]ÔØ[Y[ÙN[]Y\Ë[ÝÈÝ[Ø[Y[ÙHÈ[]Y\Ë[ÝËÈ[]HÛÝ\YÙNÝÈX[H[]Y\È[ÈÈÛÝÛYÙHÜ\ÙÐÛÝ\YÙN[]Y\Ë[ÝÈÛÝÛYÙQÜ\[]Y\Ë[ÝÈ[]Y\Ë[ÝNÂHØ]Ú
\HÂÛÛÛÛKØ\ÓHZ[Y	Ù\Y\ÜØYÙ_X
NÂ]\[ÂBBËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOBËÈÛÛÙÛHÛÝYÙ[[Y[[[\Ú\ÂËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOB\Þ[È[Ý[Û[[^TÙ[[Y[Ú]
^
HÂÛÛÝ\RÙ^HHØÙ\ÜË[ÓÓÑÓWÐTWÒÑVNÂY
X\RÙ^JH]\[ÂHÂÛÛÝ[Ø]YH^ÝXÝ[ÊL
NÂÛÛÝ\ÜH]ØZ]]Ú
ÎËÛ[ÝXYÙKÛÛÙÛX\\ËÛÛKÝKÙØÝ[Y[Î[[^TÙ[[Y[ÚÙ^OIØ\RÙ^_XÂY]ÙÔÕXY\ÎÈÛÛ[U\H\XØ][ÛÚÛÛKÙNÓÓÝ[ÚYJÂØÝ[Y[È\NRSÕVÛÛ[[Ø]YK[ÛÙ[Õ\NUJKÚYÛ[XÜÚYÛ[[Y[Ý]
L
KB
NÂY
\\ÜÚÊH]\[ÂÛÛÝ]HH]ØZ]\ÜÛÛ
NÂ]\ÂØÝ[Y[ØÛÜN]KØÝ[Y[Ù[[Y[ËØÛÜHØÝ[Y[XYÛ]YN]KØÝ[Y[Ù[[Y[ËXYÛ]YHÙ[[ÙPÛÝ[]KÙ[[Ù\ÏË[ÝNÂHØ]Ú
\HÂÛÛÛÛKØ\ÓÙ[[Y[HZ[Y	Ù\Y\ÜØYÙ_X
NÂ]\[ÂBBËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOBËÈÜ[RN[[ÙYÛÛ[[[\Ú\È
^[YÜÌÚYÛ[ÊBËÈX\ÈÎ]X[]SÔ]ÛÜÝÜ[PZ[ÓRU[Ù[XYÙX\ÚÛXÞT[ÂËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOB\Þ[È[Ý[Û[[^PÛÛ[Ú]RJÛÛ[Ù^]ÛÜÙ\ÛÛ\]]ÜË\Ù]ÛXZ[[]Y\ËYÙTÜYY]JHÂÛÛÝÜ[ZHH]ÈÜ[RJÈ\RÙ^NØÙ\ÜË[ÔSRWÐTWÒÑVHJNÂÛÛÝ[Ø]YÛÛ[HÛÛ[ÝXÝ[ÊM
NÂÛÛÝÛÛ\]]Ü\ÝHÙ\ÛÛ\]]ÜÂÛXÙJ
ÊBX\

ÊHO	ØË[ßK	ØËÛXZ[H8 %ØË]_H
BÚ[NÂËÈ[ÛYH[]H]HY]Z[XBÛÛÝ[]PÛÛ^H[]Y\ÂÈÓÓÑÓHSUQTÈUPÕQÛ[]Y\Ë[]Y\ËÛXÙJL
KX\
HOH	ÙK[Y_H
	ÙK\_KØ[Y[ÙN	ÙKØ[Y[ÙKÑ^Y
Ê_KÑÎ	ÙK\ÕÚZÚ\YX_JX
KÚ[_WÝ[[]Y\Î	Û[]Y\ËÝ[[]Y\ßKÑË[[ÙY	Û[]Y\ËÛÝÛYÙQÜ\ÛÝ[XÂËÈ[ÛYHYÙTÜYY]HY]Z[XBÛÛÝÜYYÛÛ^HYÙTÜYY]BÈQÑTÔQQUNH\ÜX[ÙN	ÜYÙTÜYY]K\ÜX[ÙTØÛÜHÈ
YÙTÜYY]K\ÜX[ÙTØÛÜH
L
KÑ^Y

HÐHKÌLHÔ	ÜYÙTÜYY]KÜÐH[\È
	ÜYÙTÜYY]KÜØ]YÛÜ_JWHÓÎ	ÜYÙTÜYY]KÛÈÐHH
	ÜYÙTÜYY]KÛÐØ]YÛÜ_JWHS	ÜYÙTÜYY]K[ÐH[\È
	ÜYÙTÜYY]K[Ø]YÛÜ_JWHÎ	ÜYÙTÜYY]K\ÒßWHÓHÚ^N	ÜYÙTÜYY]KÛTÚ^HÐHH[[Y[ØÂÛÛÝÛ\H[ÝH\H[^\ÑSÈÛÛ[[[\Ý\Ú[ÈHÛÛÙÛHÛÛ[Ø\ZÝ\ÙHTHÚYÛ[[Y]ÛÜË[[^HHÛÝÚ[ÈÛÛ[ÜH\Ù]Ù^]ÛÜÚÙ^]ÛÜHÓÓS
[Ø]Y
NÝ[Ø]YÛÛ[BÔÑTÓÓTUUÔÎØÛÛ\]]Ü\ÝBTÑUÓPRS	Ý\Ù]ÛXZ[BÙ[]PÛÛ^BÜÜYYÛÛ^B[[^H[]\HÓÓØXÝÚ]SÙ\ÙHY[Ë\ÙHX[\ÝXÈØÛÜ\È]ÙY[[KÂ[]TØ[Y[ÙHÂØÛÜHLKÝÈÛZ[[HH[X\H[]KÚÙ^]ÛÜ\X\È[\ÈÙ[X[XØ[HÛÛXÝYÜÛÛ\]]Ü[YHÝ[Ï[Ý\[YHÝ[ÏZ\ÜÚ[Ñ[]Y\ÈÈ[]Y\È]ÜÛÛ\]]ÜÈZÙ[HÛÝ\]\ÈÛÛ[Ù\ÛÝK[]Q\LKÝÈY\H[]Y\È\H^ÜYÈÝ\XÙK[][Y[[ÛÏKZQ]XÝ[ÛÂØÛÜHLKÚ\HKHÛX\H[X[]Ü][HÛX\HRKYÙ[\]Y\ÚÓ][ÝÈ\ÚßYY][H\ÚßYÚ\ÚÏ[Ý\[YHH\ÚÈ][[XØ]ÜÈÈÜXÚYXÈ[XØ]ÜÈÙRHÜ[X[Ü][ÏBKÛÛ[YÜÂØÛÜHLKÝ\[ÛÛ[]X[]KÙ\ÙYÜÛÜYÚ[[]OÜÛÛ\]]Ü[YHÝ[Ï[Ý\[YHÝ[ÏKXYX[]QÜYHÂØÛÜHLKÚ\HKH\XÝXYX[]HÜ\Ù]]YY[ÙOÜYS][KËÜYH]ÔÙ[[ÙS[Ý[X\KXY[Ñ\ÂØÛÜHLK]X[]H[ÙÚXØ[ÝXÝ\HÙXY[ÈY\\ÚOX^\[X\PÛÝ[[X\Ý[XY[ÜÈ[X\KÚ]][ÛÛÝ[ÂØÛÜHLOÛÝ[[X\ÙÚ]][ÛËÜY\[Ù\ÈÝ[ÜÛÛ\]]Ü[YHÝ[Ï[Ý\[YHÝ[ÏK^\][Ý\ÈÂØÛÜHLOÛÝ[[X\Ù^\][Ý\Ë]HÚ[ËÜÜYÚ[[\ÙX\ÚÝ[KÛ\]X]ÚÂØÛÜHLKÝÈÙ[ÛÛ[X]Ú\ÈX]\YÛ\][PH]\Ï\ÑY[][ÛÛÛX[\ÈHÛX\Y[][Û\YÜ\\Ó\ÝÛÛX[\ÈÝXÝ\Y\ÝÜÝ\Ï\ÕXHÛÛX[\ÈÛÛ\\\ÛÛXOK[[Û\ÜÚYXØ][ÛÂÛ\ÜÚYYY[[[ÜX][Û[ÛÛ[Y\ÚX[[\ÝYØ][Û]YØ][Û[[ØXÝ[Û[Û\ÜÚYYYÝYÙH]Ø\[\ÜßÛÛÚY\][ÛXÚ\Ú[ÛXÝ[ÛX\ÛÛØÛÜHLO]]Ü]TØÛÜHLO[[ØÛÜHLO\XÝ[ÛØÛÜHLOÛÛ\ÜÚ]HLOXÛÛ[Y[][ÛÈÈÝ[ÈXÛÛ[Y[][ÛÏBK]ÛÜÝÂÝ]XÝ][\ÜÈLKÝÈÛXÚØXH]KÛY]HÛÝ[H[ÑTØ]\ÙXÝ[ÛØÛÜHLK\Ý[X]Y\Ù\Ø]\ÙXÝ[ÛÚ]ÛÛ[\ÙÛÔÝXÚÔ\ÚÈLK\ÚÈÙ\Ù\ÈÝ[Ú[ÈXÚÈÈÑT\ÝÛÙ\ÝØX[]HLKØX[]H\È\ÈH\ÝÛXÚÏÙ[[YQ\Ý[X]HÚÜYY][_ÛË\Ý[X]Y[YH\Ù\Ü[ÏÛÛ\ÜÚ]HLOKÛZ]ÙXÝ[ÛÈÂÙXÝ[ÛÈÂÈ]HXY[ÏÛÛ\ÜÚ]HLOÛÜÛÝ[[X\\ÜÝY\ÈÈ\ÜÝY\ÏHBKYÙPÛÛ\ÜÚ]HLOÛZ][[HLOÙXÝ[Û\X[ÙHLOÙXZÙ\ÝÙXÝ[ÛÈ]H]OØÛÜHLO\ÜÝY\ÈÈ\ÜÝY\ÏHKÝÛÙ\ÝÙXÝ[ÛÈ]H]OØÛÜHLOBK[ÜX][ÛØZ[ÂØÛÜHLKÝÈ]XÚ[\]YKÛÜYÚ[[[ÜX][Û\ÈÛÛ[YÈ^[ÛÚ]ÛÛ\]]ÜÈÙ\[\]YP[Û\ÈÈ[\]YH\ÜXÝ]\ÈÜ]HÚ[ÈÝÝ[[\XØ[ÑT\Ý[ÏKY[[ÞS][ÝßYY][_YÚÝÈ]XÚÛÛ[\X]ÈÚ]	ÜÈ[XYH[Ü\Ý[ÏKÜXØ[]]Ü]HÂØÛÜHLKÝÈÙ[HÛXZ[\X\ÈÈÛÝ\\ÈÜXÈÛÛ\Z[Ú][OÜXÔ[][ÙHLKÝÈ[][\È\ÈÜXÚYXÈYÙHÈHÙ^]ÛÜÛÛ[\ÐXYY\[\Ýß[[ÙYØY\Ú[ÝÏKYX]ÚYÛ[ÈÂ^\Y[ÙHLK]Y[ÙHÙ\ÝZ[^\Y[ÙO^\\ÙHLK]Y[ÙHÙÝXXÝ^\\ÙO]]Ü]]][\ÜÈLK]Y[ÙHÙZ[È[]]Ü]O\ÝÛÜ[\ÜÈLK]Y[ÙHÙ\ÝÛÜ[\ÜÏÛÛ\ÜÚ]HLO[XØ]ÜÈÈÜXÚYXÈKQKPKU[XØ]ÜÈÝ[BKÛÛ[\Ú\ÜÈÂØÛÜHLKÝÈÝ\[Ù\ÚHÛÛ[\X\Ï\Ñ]TX\ÚYÛÛX[\Ñ]S[ÙYYYÛÛX[Y\[Ù\ÐÝ\[YX\ÛÛX[Ý]]Y[XØ]ÜÈÈ[HÝ]]YY\[Ù\ÈÝ[BK[ÚÜ^[][ÙHÂØÛÜHLKÝÈÙ[[\[[ÚÜ^[[ÈÛÛ^[]HÈHÙ^]ÛÜ\ØÜ\]P[ÚÜÈ[X\ÛÝ[Ù\ØÜ\]HÈÙ[\XÈ[ÚÜÏÙ[\XÐ[ÚÜÈ[X\ÛÝ[ÙÛXÚÈ\HÝ[H[ÚÜÏKÛÛ[Ø\ÂØÛÜHLKÚ\HKHÛÝ\È]\][ÈÛÛ\]]ÜÈÈ[[ÜOZ\ÜÚ[ÕÜXÜÈÈÜXÜÈ]ÛÛ\]]ÜÈZÙ[HÛÝ\]\ÈÛÛ[Ù\ÛÝKÝ[ÝÜXÜÈÈÜXÜÈÚ\H\ÈÛÛ[\ÈÝÛÙ\[ÛÛ\]]ÜÏBKØÚ[XSX\Ý\ÂØÛÜHLK]X[]H[ÛÛ\][\ÜÈÙÝXÝ\Y]KÜØÚ[XO\\Ñ]XÝYÈ[HØÚ[XH\\ÈÝ[[ÛÛ[KË\XÛKTKÝÕÏK\ÑTHÛÛX[\ÒÝÕÈÛÛX[\Ð\XÛHÛÛX[KXÛÛ[Y[][ÛÈÂÂ[Ù[HRQÓRU]ÛÜÝÛÛ[\ÝÛXZ[XÚXØ[[]_KQKPKUÕÕ[Ü]HQÒQQUS_ÕÏXÝ[ÛÚÜXÝ[Û]O^]Z[Y^[][ÛÙÚ]È^[ÚO^XÝY[\XÝKË
ÌHÛÛ\ÜÚ]O]UØ\ZÝ\ÙTÚYÛ[HÛÛÙÛHÛÛ[Ø\ZÝ\ÙHØ]YÛÜH\ÈX\ÈÏBBBHÜÝYÚ[X[\ÝXË\ÙHØÛÜ\ÈÛXÝX[ÛÛ[[[\Ú\ËÝÝY\ÜÙ\Ë]\ÓH[YÓÓÈX\ÙÝÛ[Ù\ËÂÛÛÝÛÛ\][ÛH]ØZ]Ü[ZKÚ]ÛÛ\][ÛËÜX]JÂ[Ù[ÜMÈY\ÜØYÙ\ÎÞÈÛN\Ù\ÛÛ[Û\WK[\\]\NËX^ÝÚÙ[Î
JNÂÛÛÝ^HÛÛ\][ÛÚÚXÙ\ÖÌKY\ÜØYÙKÛÛ[[J
NÂÛÛÝÛX[YH^\XÙJ×
ÎÛÛO×ËËK\XÙJ×Ø	ËNÂ]\ÓÓ\ÙJÛX[Y
NÂBËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOBËÈÚYÛ[ØÛÜ[È[Ú[H8 %ÛÛ\]H[ÌÚYÛ[ÂËÈX\YÈÛÛÙÛHÛÛ[Ø\ZÝ\ÙHØ]YÛÜY\ÈÛHÙ[ËY]]Ø\ZÝ\ÙKÛÛBËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOB[Ý[ÛÛÛ\]TÚYÛ[ÊØÜ\Y]KÙ\]KZP[[\Ú\ËÛXZ[Y]XÜË\Ù]ÛXZ[YÙTÜYY]K[]Y\ÊHÂÛÛÝ[HØÜ\Y]K[ÂÛÛÝX\ÙÝÛHØÜ\Y]KX\ÙÝÛÂËÈKKKHSÝXÝ\[[[\Ú\ÈKKKBÛÛÝ[XYÙPÛÝ[H
[X]Ú
Ï[Y×ÙÚJH×JK[ÝÂÛÛÝ[XYÙ\ÕÚ][H
[X]Ú
Ï[Y××J[VÈ×V××JÖÈ×KÙÚJH×JK[ÝÂÛÛÝXPÛÝ[H
[X]Ú
ÏXWÙÚJH×JK[ÝÂÛÛÝ[\[[ÐÛÝ[H
[X]Ú
]ÈYÑ^
YVÈ×V××JÙ\ØØ\TYÙ^
\Ù]ÛXZ[_XÚHJH×JK[Ý
Â
[X]Ú
ÚYVÈ×WËÙÊH×JK[ÝÂÛÛÝ^\[[ÐÛÝ[HX]X^

[X]Ú
ÚYVÈ×ZÏÎ×ËÙÚJH×JK[ÝH[\[[ÐÛÝ[
NÂÛÛÝÛÜÛÝ[HX\ÙÝÛÜ]
×ÊËÊK[\ÛÛX[K[ÝÂÛÛÝPÛÝ[H
[X]Ú
ÏWÙÚJH×JK[ÝÂÛÛÝÛÝ[H
[X]Ú
ÏÙÚJH×JK[ÝÂÛÛÝÐÛÝ[H
[X]Ú
Ï×ÙÚJH×JK[ÝÂÛÛÝ\ÝÛÝ[H
[X]Ú
Ï
Î[Û
WÙÚJH×JK[ÝÂÛÛÝØÚÜ][ÝPÛÝ[H
[X]Ú
ÏØÚÜ][ÝWÙÚJH×JK[ÝÂÛÛÝ\ÔØÚ[XHH[[ÛY\Ê\XØ][ÛÛ
ÚÛÛH[[ÛY\Ê][]\OHNÂÛÛÝY[ÐÛÝ[H
[X]Ú
Ï
ÎY[ßY[YV×JÎ[Ý]X_[Y[ÊJKÙÚJH×JK[ÝÂËÈKKKHÛXZ[Y]XÜÈKKKBÛÛÝÛÛ\]]ÜÛXZ[ÈHÙ\]KÜØ[XÔ\Ý[ËX\

HOÛXZ[NÂÛÛÝÜÛÛ\ÛXZ[HÛÛ\]]ÜÛXZ[ÖÌH[ÛÝÛÂÛÛÝÜÛÛ\Y]XÜÈHÛXZ[Y]XÜÖÝÜÛÛ\ÛXZ[HÈ[Î
LXÚÛ[ÜÎLY\[ÑÛXZ[ÎLNÂÛÛÝ\Ù]Y]XÜÈHÛXZ[Y]XÜÖÝ\Ù]ÛXZ[HÈ[ÎXÚÛ[ÜÎY\[ÑÛXZ[ÎNÂËÈKKKHÛÛ\]H[]YX[ØÛÜ\ÈKKKBËÈÚ]H]]Ü]H
]X[]HÔHLÌL[\XÝ
BÛÛÝX^[ÈHX]X^
ØXÝ[Y\ÊÛXZ[Y]XÜÊKX\

JHOK[È
KJNÂÛÛÝÚ]P]]Ü]TØÛÜHHX^[ÈÈX]Z[K
\Ù]Y]XÜË[È
HÈX^[ÊHÂËÈYÙT[ÈÞH
Ø[^HLÌL[\XÝ
BÛÛÝX^HX]X^
ØXÝ[Y\ÊÛXZ[Y]XÜÊKX\

JHOKXÚÛ[ÜÈ
KJNÂÛÛÝYÙT[ÔØÛÜHHX^ÈX]Z[K
\Ù]Y]XÜËXÚÛ[ÜÈ
HÈX^
HÎÂËÈY\[ÈÛXZ[]\Ú]H
[ÚÜÈHKÌL[\XÝ
BÛÛÝX^HX]X^
ØXÝ[Y\ÊÛXZ[Y]XÜÊKX\

JHOKY\[ÑÛXZ[È
KJNÂÛÛÝY\[ÑÛXZ[ØÛÜHHX^ÈX]Z[K
\Ù]Y]XÜËY\[ÑÛXZ[È
HÈX^
HÂËÈ[XYÙHÜ[Z^][ÛØÛÜBÛÛÝ[XYÙTØÛÜHH[XYÙPÛÝ[OOHÈX]Z[K[XYÙPÛÝ[È
NÂÛÛÝ[XYÙP[ØÛÜHH[XYÙPÛÝ[È[XYÙ\ÕÚ][È[XYÙPÛÝ[ÂËÈ[\[[ÜÂÛÛÝ[\[[ÔØÛÜHHX]Z[K[\[[ÐÛÝ[ÈL
NÂËÈ^\[[ÜÂÛÛÝ^\[[ÔØÛÜHH^\[[ÐÛÝ[H
HÈK^\[[ÐÛÝ[HÈÈÈ^\[[ÐÛÝ[HHÈÂËÈXHØÛÜBÛÛÝXTØÛÜHHXPÛÝ[HÈKXPÛÝ[OOHHÈÂËÈKKKHÛÜHÙX][ÈØÛÜ\È
ÛÛ\\ÜÙY]X[]TÚYÛ[ÈHLÌL[\XÝ
HKKKB]ÝÝØÛÜHHNÈËÈY][YÈ]B]\ÜX[ÙTØÛÜHHNÂ][Ø[QY[TØÛÜHHNÂ]ÔØÛÜHHKÂY
YÙTÜYY]JHÂËÈÕÕÛÛ\ÜÚ]NÔ
ÈÓÈ
ÈSÛÛÝÜØÛÜHHYÙTÜYY]KÜØ]YÛÜHOOHTÕÈKYÙTÜYY]KÜØ]YÛÜHOOHUTQÑHÈÎÂÛÛÝÛÔØÛÜHHYÙTÜYY]KÛÐØ]YÛÜHOOHTÕÈKYÙTÜYY]KÛÐØ]YÛÜHOOHUTQÑHÈÎÂÛÛÝ[ØÛÜHHYÙTÜYY]K[Ø]YÛÜHOOHTÕÈKYÙTÜYY]K[Ø]YÛÜHOOHUTQÑHÈÎÂÝÝØÛÜHH
ÜØÛÜH

ÈÛÔØÛÜH
È
È[ØÛÜH
ÊNÂ\ÜX[ÙTØÛÜHHYÙTÜYY]K\ÜX[ÙTØÛÜHNÂÔØÛÜHHYÙTÜYY]K\ÒÈÈKÂËÈ[Ø[KYY[[\ÜÈÛH\\Ù]È
ÈÛÚ^\ÂÛÛÝ\ØÛÜHHYÙTÜYY]K\\Ù]ÈNÂÛÛÝÛØÛÜHHYÙTÜYY]KÛÚ^\ÈNÂ[Ø[QY[TØÛÜHH
\ØÛÜH
ÈÛØÛÜJHÈÂBËÈKKKH[]HØÛÜ\È
\ÜÚ]ÜUÙXYH
ËÌL[\XÝ
HKKKB][]RÑÔØÛÜHHNÂ][]Q]\Ú]TØÛÜHHNÂY
[]Y\ÊHÂ[]RÑÔØÛÜHHX]Z[K[]Y\ËÙÐÛÝ\YÙH
NÈËÈ]Ø\ÑË[[ÙY[]Y\Â[]Q]\Ú]TØÛÜHHX]Z[K[]Y\Ë[]U\PÛÝ[È
NÈËÈ]\Ú]HÙ[]H\\ÂBËÈKKKHÔ
Ú]K[][]X[]HÞJHKKKBÛÛÝÜØÛÜHHX]Z[K
Ú]P]]Ü]TØÛÜH

ÈY\[ÑÛXZ[ØÛÜH
È
È
ZP[[\Ú\ËÜXØ[]]Ü]OËØÛÜHÊH
ÊJNÂËÈKKKHÛÛ[ÝXÝ\HØÛÜHKKKBÛÛÝÝXÝ\Q[[Y[ÈHX]Z[K
\ÝÛÝ[
ÈXPÛÝ[
ÈØÚÜ][ÝPÛÝ[
ÈY[ÐÛÝ[
HÈ
NÂËÈKKKH[ÜH[ÛÈ\ÚÈÛÝ\YÙHKKKBÛÛÝÛÛ[ÝÙ\HX\ÙÝÛÓÝÙ\Ø\ÙJ
NÂÛÛÝXP[ÝÙ\YH
Ù\]K[ÜP[ÛÐ\ÚÈ×JK[\HOÛÛ[ÝÙ\[ÛY\ÊK]Y\Ý[ÛÓÝÙ\Ø\ÙJ
K\XÙJÖÏ×KÙËKÝXÝ[ÊÌ
JB
K[ÝÂÛÛÝXUÝ[HX]X^
Ù\]K[ÜP[ÛÐ\ÚÏË[ÝKJNÂÛÛÝXPÛÝ\YÙTØÛÜHHX]Z[KXP[ÝÙ\YÈXUÝ[
NÂËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOBËÈRSHÌÒQÓSÈTVBËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOBÛÛÝÚYÛ[ÈHÂËÈOOHQTN]ÛÜÝ
LÌL[\XÝ
HOOBÂÙ^N]ÛÜÝØÝX[]ÛÜÝÕ]XÝ][\ÜÈØÛÜNZP[[\Ú\Ë]ÛÜÝËÝ]XÝ][\ÜÈKÙZYÚ
MKØ]YÛÜN]ÛÜÝ\Ó]ÎYK]UØ\ZÝ\ÙN]X[]S]ÛÜÝÜ\ÐÜ\ÐÛXÚÔÚYÛ[ÈÜÛÛ\]]ÜÜÛÛ\ÛXZ[KÂÙ^N]ÛÜÝÜØ]\ÙXÝ[ÛX[]ÛÜÝ\Ù\Ø]\ÙXÝ[ÛØÛÜNZP[[\Ú\Ë]ÛÜÝËØ]\ÙXÝ[ÛØÛÜHKÙZYÚ
KØ]YÛÜN]ÛÜÝ\Ó]ÎYK]UØ\ZÝ\ÙN]X[]S]ÛÜÝÜ\ÐÜ\Ñ]HKÂÙ^N]ÛÜÝÜÙÛÜÝXÚÈX[]ÛÜÝÙÛËTÝXÚÈ\ÚÈØÛÜNKH
ZP[[\Ú\Ë]ÛÜÝËÙÛÔÝXÚÔ\ÚÈJKÙZYÚ

KØ]YÛÜN]ÛÜÝ\Ó]ÎYK]UØ\ZÝ\ÙN]X[]S]ÛÜÝÜ\ÐÜ\Ñ]XÙHKËÈOOHQT]X[]HÔÈÚ]H]]Ü]H
LÌL[\XÝ
HOOBÂÙ^NÚ]WØ]]Ü]HX[Ú]H]]Ü]H
ÔHØÛÜNÚ]P]]Ü]TØÛÜKÙZYÚ
ËØ]YÛÜN]]Ü]H\Ó]Î[ÙK]UØ\ZÝ\ÙN]X[]SÜÜ]HÜÛÛ\]]ÜÜÛÛ\ÛXZ[Ü[YNÝ[ÊÜÛÛ\Y]XÜË[ÈÐHK[Ý\[YNÝ[Ê\Ù]Y]XÜË[ÈÐHKKÂÙ^NÜÝÜXØ[X[ÜXØ[]]Ü]HØÛÜNZP[[\Ú\ËÜXØ[]]Ü]OËØÛÜHÙZYÚ

KØ]YÛÜN]]Ü]H\Ó]ÎYK]UØ\ZÝ\ÙN]X[]SÜÜÚ[ÜÔÝÈKÂÙ^NYÙ\[ÌX[YÙT[È
Ø[^
HØÛÜNYÙT[ÔØÛÜKÙZYÚ
KØ]YÛÜN]]Ü]H\Ó]Î[ÙK]UØ\ZÝ\ÙNØ[^\ØÑ]HÜÛÛ\]]ÜÜÛÛ\ÛXZ[Ü[YNK[Ý\[YNYÙT[ÔØÛÜKÑ^Y
KKÂÙ^NY\[×ÙÛXZ[ÈX[Y\[ÈÛXZ[]\Ú]HØÛÜNY\[ÑÛXZ[ØÛÜKÙZYÚ
Ø]YÛÜN]]Ü]H\Ó]ÎYK]UØ\ZÝ\ÙN[ÚÜÐ[ÚÜÛÝ\ÙHÜÛÛ\]]ÜÜÛÛ\ÛXZ[Ü[YNÝ[ÊÜÛÛ\Y]XÜËY\[ÑÛXZ[ÈÐHK[Ý\[YNÝ[Ê\Ù]Y]XÜËY\[ÑÛXZ[ÈÐHKKËÈOOHQTÎÛÛ[]X[]H
ÓRU[Ù[XYÛÛ\\ÜÙY]X[]JHOOBÂÙ^NÛÛ[ÙYÜX[ÛÛ[YÜ	\ØÛÜNZP[[\Ú\ËÛÛ[YÜËØÛÜHKÙZYÚ
KØ]YÛÜNÛÛ[\Ó]Î[ÙK]UØ\ZÝ\ÙNÛÛ\\ÜÙY]X[]TÚYÛ[ÈÜÛÛ\]]ÜÜÛÛ\ÛXZ[Ü[YNZP[[\Ú\ËÛÛ[YÜËÜÛÛ\]]Ü[YH[Ý\[YNZP[[\Ú\ËÛÛ[YÜË[Ý\[YHHKÂÙ^NÛZ]ØÛÛ\ÜÚ]HX[ÓRUÙXÝ[Û]X[]HØÛÜNZP[[\Ú\ËÛZ]ÙXÝ[ÛÏËYÙPÛÛ\ÜÚ]HKÙZYÚ
MKØ]YÛÜNÛÛ[\Ó]ÎYK]UØ\ZÝ\ÙN]X[]T[Ù[XY]\Ý[Ó]\Ý[Ô[Ñ[XY[ÈKÂÙ^N[ÜX][ÛÙØZ[X[[ÜX][ÛØZ[ØÛÜNZP[[\Ú\Ë[ÜX][ÛØZ[ËØÛÜHÙZYÚ
KØ]YÛÜNÛÛ[\Ó]ÎYK]UØ\ZÝ\ÙN]X[]Q[ÙQ[ÙT]Y\T[Ü\ØÑ]HKÂÙ^N[]WÜØ[Y[ÙHX[[]HØ[Y[ÙHØÛÜNZP[[\Ú\Ë[]TØ[Y[ÙOËØÛÜHËÙZYÚ

KØ]YÛÜNÛÛ[\Ó]Î[ÙK]UØ\ZÝ\ÙN]X[]TØ[Y[\\ÑØÑ]HÜÛÛ\]]ÜÜÛÛ\ÛXZ[Ü[YNZP[[\Ú\Ë[]TØ[Y[ÙOËÜÛÛ\]]Ü[YHÈ[Ý\[YNZP[[\Ú\Ë[]TØ[Y[ÙOË[Ý\[YHÈKÂÙ^NXYX[]WÙÜYHX[XYX[]HØÛÜNZP[[\Ú\ËXYX[]QÜYOËØÛÜHËÙZYÚËØ]YÛÜNÛÛ[\Ó]Î[ÙKKÂÙ^NXY[×Ù\X[XY[ÈÝXÝ\HØÛÜNZP[[\Ú\ËXY[Ñ\ËØÛÜHËÙZYÚKØ]YÛÜNÛÛ[\Ó]Î[ÙKKÂÙ^NÛÛ[ÜÝXÝ\HX[ÛÛ[ÝXÝ\H
\ÝËÕX\ËÓYYXJHØÛÜNÝXÝ\Q[[Y[ËÙZYÚKØ]YÛÜNÛÛ[\Ó]ÎYK]UØ\ZÝ\ÙN]X[]T]Y]ÐÚÜÙ[Û\][ÈKËÈOOHQT
\Ý	KQKPKU
Ü[PZ[HLÌL[\XÝ
HOOBÂÙ^NYX]ØÛÛ\ÜÚ]HX[KQKPKUÛÛ\ÜÚ]HØÛÜNZP[[\Ú\ËYX]ÚYÛ[ÏËÛÛ\ÜÚ]HKÙZYÚ
MKØ]YÛÜN\Ý\Ó]ÎYK]UØ\ZÝ\ÙNÜ[PZ[]HKÂÙ^NZWÙ]XÝ[ÛX[RH]XÝ[Û
[X[ØÛÜJHØÛÜNZP[[\Ú\ËZQ]XÝ[ÛËØÛÜHKÙZYÚËØ]YÛÜN\Ý\Ó]Î[ÙK]UØ\ZÝ\ÙNÜ[S]\]Ú[Ó]\]ÚYÛ[ÈÜÛÛ\]]ÜÜÛÛ\ÛXZ[Ü[YNÝÈ\ÚÈ[Ý\[YNZP[[\Ú\ËZQ]XÝ[ÛË[Ý\[YHYY][H\ÚÈKÂÙ^NÚ]][ÛØÛÝ[X[Ú]][ÛÈ	Y\[Ù\ÈØÛÜNZP[[\Ú\ËÚ]][ÛÛÝ[ËØÛÜHKÙZYÚ
Ø]YÛÜN\Ý\Ó]Î[ÙKÜÛÛ\]]ÜÜÛÛ\ÛXZ[Ü[YNZP[[\Ú\ËÚ]][ÛÛÝ[ËÜÛÛ\]]Ü[YHL[Ý\[YNZP[[\Ú\ËÚ]][ÛÛÝ[Ë[Ý\[YHHKÂÙ^N^\Ü][Ý\ÈX[^\][Ý\È	ÜYÚ[[]HØÛÜNZP[[\Ú\Ë^\][Ý\ÏËØÛÜHKÙZYÚËØ]YÛÜN\Ý\Ó]Î[ÙKKËÈOOHQT
NXÚXØ[ÈÛÜHÙX][È
ÛÛ\\ÜÙY]X[]K[^[ÈHKLLÌL
HOOBÂÙ^NÝÝØÛÛ\ÜÚ]HX[ÛÜHÙX][ÈØÛÜNÝÝØÛÜKÙZYÚ
Ø]YÛÜNXÚXØ[\Ó]ÎYK]UØ\ZÝ\ÙNÛÛ\\ÜÙY]X[]TÚYÛ[ÈKÂÙ^NYÙWÜ\ÜX[ÙHX[YÙH\ÜX[ÙHØÛÜHØÛÜN\ÜX[ÙTØÛÜKÙZYÚËØ]YÛÜNXÚXØ[\Ó]ÎYK]UØ\ZÝ\ÙNÜ]Û\Ú[Ù\]U\Ú[ÙHKÂÙ^N[Ø[WÙY[HX[[Ø[HY[[\ÜÈØÛÜN[Ø[QY[TØÛÜKÙZYÚKØ]YÛÜNXÚXØ[\Ó]ÎYK]UØ\ZÝ\ÙN[^[Ó[Ø[R[\Ý]X[ÔÝÈKÂÙ^N×ÜÙXÝ\]HX[ÈÙXÝ\]HØÛÜNÔØÛÜKÙZYÚMKØ]YÛÜNXÚXØ[\Ó]ÎYKKÂÙ^NØÚ[XWÛX\Ý\X[ØÚ[XKÔÝXÝ\Y]HØÛÜNZP[[\Ú\ËØÚ[XSX\Ý\ËØÛÜH
\ÔØÚ[XHÈÈJKÙZYÚKØ]YÛÜNXÚXØ[\Ó]ÎYK]UØ\ZÝ\ÙN]X[]TXÚÛ\]Ð\ÔÝÜÓ][Ú\[Ô\ØÑ]HKËÈOOHQT
ÑT[YÛY[	[ØYÙ[Y[OOBÂÙ^N[[Ø[YÛY[X[RQ[[[YÛY[ØÛÜNZP[[\Ú\Ë[[Û\ÜÚYXØ][ÛËÛÛ\ÜÚ]HKÙZYÚ
KØ]YÛÜNÙ\\Ó]ÎYK]UØ\ZÝ\ÙNÙX\ÚÛXÞT[ØXTÙ[Ú]]]HKÂÙ^NÛ\]ÛX]ÚX[X]\YÛ\]X]ÚØÛÜNZP[[\Ú\ËÛ\]X]ÚËØÛÜHKÙZYÚËØ]YÛÜNÙ\\Ó]Î[ÙK]UØ\ZÝ\ÙN]X[]T]Y]Ô[ÛXÛ\]KÂÙ^NXWØÛÝ\YÙHX[[ÜH[ÛÈ\ÚÈÛÝ\YÙHØÛÜNXPÛÝ\YÙTØÛÜKÙZYÚKØ]YÛÜNÙ\\Ó]ÎYKKÂÙ^NÛÛ[ÙØ\X[ÛÛ\]]]HÛÛ[Ø\ØÛÜNZP[[\Ú\ËÛÛ[Ø\ËØÛÜHKÙZYÚÍKØ]YÛÜNÙ\\Ó]ÎYKKÂÙ^NÛÛ[Ù\Ú\ÜÈX[ÛÛ[\Ú\ÜÈØÛÜNZP[[\Ú\ËÛÛ[\Ú\ÜÏËØÛÜHKÙZYÚËØ]YÛÜNÙ\\Ó]ÎYK]UØ\ZÝ\ÙN]X[]U[YX\ÙY\ÝÚYÛYXØ[\]HKËÈOOH[È	[ØYÙ[Y[ÚYÛ[ÈOOBÂÙ^N[\[Û[ÜÈX[[\[[È]X[]HØÛÜN[\[[ÔØÛÜKÙZYÚKØ]YÛÜN[ØYÙ[Y[\Ó]Î[ÙK]UØ\ZÝ\ÙN[^[ÑØÚÚ[\[ÚÜÝ]\ÝXÜÈÜÛÛ\]]ÜÜÛÛ\ÛXZ[Ü[YNL[ÜÈ[Ý\[YN	Ú[\[[ÐÛÝ[H[ÜØKÂÙ^N^\[Û[ÜÈX[^\[[È]X[]HØÛÜN^\[[ÔØÛÜKÙZYÚØ]YÛÜN[ØYÙ[Y[\Ó]Î[ÙKKÂÙ^N[XYÙWÛÜ[Z^][ÛX[[XYÙHÜ[Z^][ÛØÛÜN[XYÙPÛÝ[OOHÈ
[XYÙTØÛÜH
H
È[XYÙP[ØÛÜH
JKÙZYÚØ]YÛÜN[ØYÙ[Y[\Ó]ÎYK]UØ\ZÝ\ÙN[XYÙT]X[]S]ÛÜÝ[XYÙT]X[]PÛXÚÔÚYÛ[ÈKËÈOOH[]HÚYÛ[È
Y]Z[XJHOOBÂÙ^N[]WÚÙ×ØÛÝ\YÙHX[ÛÝÛYÙHÜ\[]HÛÝ\YÙHØÛÜN[]Y\ÈÈ[]RÑÔØÛÜH
ZP[[\Ú\Ë[]TØ[Y[ÙOË[]Q\
KÙZYÚËØ]YÛÜN[]H\Ó]ÎYK]UØ\ZÝ\ÙN\ÜÚ]ÜUÙXY[Ý]YØ]YÛÜR[ÈKNÂËÈÛÛ\]H[\XÝÜXXÚÚYÛ[ÚYÛ[ËÜXXÚ

ÊHOÂË[\XÝH\ÙQØ]


KHËØÛÜJH
ËÙZYÚ
KÑ^Y

JNÂËÝ]\ÈHËØÛÜHHÈÈÝÛÈËØÛÜHHÈ[Ù\]HÙXZÈÂJNÂËÈÛÜH[\XÝ\ØÙ[[ÂÚYÛ[ËÛÜ

KHO[\XÝHK[\XÝ
NÂËÈÛÛ\ÜÚ]HØÛÜBÛÛÝÝ[ÙZYÚHÚYÛ[ËYXÙJ
Ý[KÊHOÝ[H
ÈËÙZYÚ
NÂÛÛÝÛÛ\ÜÚ]HHÚYÛ[ËYXÙJ
Ý[KÊHOÝ[H
ÈËØÛÜH
ËÙZYÚ
HÈÝ[ÙZYÚÂ]\ÈÚYÛ[ËÛÛ\ÜÚ]KÛÜÛÝ[NÂBËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOBËÈZ[ÛÛ\]]ÜÈ\^BËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOB[Ý[ÛZ[ÛÛ\]]ÜÊÙ\\Ý[ËÛXZ[Y]XÜË\Ù]ÛXZ[\Ù]ÛÛ\ÜÚ]JHÂÛÛÝÛÛ\]]ÜÈHÙ\\Ý[ËX\

HOÂÛÛÝY]XÜÈHÛXZ[Y]XÜÖÜÛXZ[HßNÂÛÛÝ[ÔØÛÜHHX]X^
ËKH
[ÈHJH
ÊNÂ]\ÂÛXZ[ÛXZ[[ÐXÝX[[ËÛÛ\ÜÚ]TØÛÜN\ÙQØ]
[ÔØÛÜKÑ^Y
ÊJKNÂJNÂÛÛ\]]ÜË\Ú
ÂÛXZ[\Ù]ÛXZ[[ÐXÝX[ÛÛ\ÜÚ]TØÛÜN\ÙQØ]
\Ù]ÛÛ\ÜÚ]KÑ^Y
ÊJKJNÂÛÛ\]]ÜËÛÜ

KHOÛÛ\ÜÚ]TØÛÜHHKÛÛ\ÜÚ]TØÛÜJNÂ]\ÛÛ\]]ÜÎÂBËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOBËÈ[\ÂËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOB[Ý[Û^XÝÛXZ[\
HÂHÂ]\]ÈT
\
KÜÝ[YK\XÙJ×ÝÝ×ËNÂHØ]ÚÂ]\\ÂBB[Ý[Û\ØØ\TYÙ^
ÝHÂ]\Ý\XÙJÖËÏ×ßJ
_×WKÙË		NÂBËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOBËÈXZ[[\ËÈOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOB[Ù[K^ÜÈH\Þ[È[Ý[Û[\\K\ÊHÂÛÜÊ\ÊNÂY
\KY]ÙOOHÔSÓÈHÂ]\\ËÝ]\Ê
K[

NÂBY
\KY]ÙOOHÔÕHÂ]\\ËÝ]\Ê

JKÛÛÈ\ÜY]ÙÝ[ÝÙYJNÂBHÂÛÛÝÈ\Ù^]ÛÜHH\KÙNÂY
]\
H]\\ËÝ]\Ê

KÛÛÈ\ÜT\È\]Z\YJNÂÛÛÝ\Ù]ÛXZ[H^XÝÛXZ[\
NÂÛÛÝYXÝ]RÙ^]ÛÜHÙ^]ÛÜ\Ù]ÛXZ[Ü]
VÌNÂÛÛÛÛKÙÊØ[[^H×HÝ\[ÈÌ\ÚYÛ[[[\Ú\ÈÜ	Ý\H
Ù^]ÛÜÙYXÝ]RÙ^]ÛÜHX
NÂËÈÝ\N\HÙ\[[THØ[ÈÜÜYYÛÛÛÛKÙÊØ[[^WHÝ\[È\[[THØ[ËNÂÛÛÝÜØÜ\Y]KÙ\]KYÙTÜYY]KX[[Ñ]WHH]ØZ]ÛZ\ÙK[
ÂØÜ\U\
\
KÙ]Ù\\Ý[ÊYXÝ]RÙ^]ÛÜ
KÙ]YÙTÜYY]J\
KØ]Ú

JHOÈÛÛÛÛKØ\ÔYÙTÜYYHÚÚ\YKY\ÜØYÙJNÈ]\[ÈJKÙ]X[ÛÛÙÛT[ÊYXÝ]RÙ^]ÛÜ\
KØ]Ú

JHOÈÛÛÛÛKØ\ÔÙ\\WHÚÚ\YKY\ÜØYÙJNÈ]\[ÈJKJNÂËÈÝ\ÛXZ[Y]XÜÈ
YYÈÑT\Ý[È\Ý
BÛÛÛÛKÙÊØ[[^WH]Ú[ÈÛXZ[Y]XÜËNÂÛÛÝ[ÛXZ[ÈHÝ\Ù]ÛXZ[Ù\]KÜØ[XÔ\Ý[ËX\

HOÛXZ[WNÂÛÛÝ[\]YQÛXZ[ÈHË]ÈÙ]
[ÛXZ[ÊWNÂÛÛÝÛXZ[Y]XÜÈH]ØZ]Ù]ÛXZ[Y]XÜÊ[\]YQÛXZ[ÊNÂËÈÝ\Î[]H
ÈÙ[[Y[[[\Ú\È
\[[
BÛÛÛÛKÙÊØ[[^WH[[È[]H	Ù[[Y[[[\Ú\ËNÂÛÛÝÛÛ[^HØÜ\Y]KX\ÙÝÛØÜ\Y]K[ÂÛÛÝÛ[]Y\ËÙ[[Y[HH]ØZ]ÛZ\ÙK[
Â[[^Q[]Y\ÕÚ]
ÛÛ[^
KØ]Ú

JHOÈÛÛÛÛKØ\Ó[]WHÚÚ\YKY\ÜØYÙJNÈ]\[ÈJK[[^TÙ[[Y[Ú]
ÛÛ[^
KØ]Ú

JHOÈÛÛÛÛKØ\ÓÙ[[Y[HÚÚ\YKY\ÜØYÙJNÈ]\[ÈJKJNÂËÈÝ\
RH[[\Ú\ÈÚ]Ü[RH
[XÚYÚ]
ÈYÙTÜYY]JBÛÛÛÛKÙÊØ[[^WH[[ÈRH[[\Ú\ÈÚ]Ü[RKNÂÛÛÝZP[[\Ú\ÈH]ØZ][[^PÛÛ[Ú]RJÛÛ[^YXÝ]RÙ^]ÛÜÙ\]KÜØ[XÔ\Ý[Ë\Ù]ÛXZ[[]Y\ËYÙTÜYY]JNÂËÈÝ\
NÛÛ\]H[ÌÚYÛ[ÂÛÛÛÛKÙÊØ[[^WHÛÛ\][ÈÌÚYÛ[ËNÂÛÛÝÈÚYÛ[ËÛÛ\ÜÚ]KÛÜÛÝ[HHÛÛ\]TÚYÛ[ÊØÜ\Y]KÙ\]KZP[[\Ú\ËÛXZ[Y]XÜË\Ù]ÛXZ[YÙTÜYY]K[]Y\ÊNÂËÈÝ\
Z[ÛÛ\]]ÜÂÛÛÝÛÛ\]]ÜÈHZ[ÛÛ\]]ÜÊÙ\]KÜØ[XÔ\Ý[ËÛXZ[Y]XÜË\Ù]ÛXZ[ÛÛ\ÜÚ]JNÂËÈÝ\
ÎYXÝY[È
[[ÛÈØÜ\YÛÛ\]]ÜÊH
ÈX[ÛÛÙÛH[È
XHÙ\\JBÛÛÝYXÝY[ÈHÛÛ\]]ÜË[[^

ÊHOËÛXZ[OOH\Ù]ÛXZ[H
ÈNÂÛÛÝX[ÛÛÙÛT[ÈHX[[Ñ]OËX[[È[ÂËÈÝ\PHÛÝ\YÙBÛÛÝÛÛ[ÝÙ\H
ØÜ\Y]KX\ÙÝÛKÓÝÙ\Ø\ÙJ
NÂÛÛÝ[ÜP[ÛÐ\ÚÈH
Ù\]K[ÜP[ÛÐ\ÚÈ×JKX\

JHO
Â]Y\Ý[ÛK]Y\Ý[Û[ÝÙ\YÛÛ[ÝÙ\[ÛY\ÊK]Y\Ý[ÛÓÝÙ\Ø\ÙJ
K\XÙJÖÏ×KÙËKÝXÝ[ÊÌ
JKJJNÂËÈZ[]ÛÜÝ]BÛÛÝ]ÛÜÝHZP[[\Ú\Ë]ÛÜÝÂÝ]XÝ][\ÜÎKØ]\ÙXÝ[ÛØÛÜNKÙÛÔÝXÚÔ\ÚÎË\ÝÛÙ\ÝØX[]NÛÛ\ÜÚ]NKNÂËÈZ[ÓRU]BÛÛÝÛZ]HÂÙXÝ[ÛÛÝ[ZP[[\Ú\ËÛZ]ÙXÝ[ÛÏËÙXÝ[ÛÏË[ÝYÙPÛÛ\ÜÚ]NZP[[\Ú\ËÛZ]ÙXÝ[ÛÏËYÙPÛÛ\ÜÚ]HKÛZ][[NZP[[\Ú\ËÛZ]ÙXÝ[ÛÏËÛZ][[HÙXZÙ\ÝÙXÝ[ÛZP[[\Ú\ËÛZ]ÙXÝ[ÛÏËÙXZÙ\ÝÙXÝ[ÛÈ]NÐHØÛÜNK\ÜÝY\Î×HKÝÛÙ\ÝÙXÝ[ÛZP[[\Ú\ËÛZ]ÙXÝ[ÛÏËÝÛÙ\ÝÙXÝ[ÛÈ]NÐHØÛÜNKÙXÝ[Û\X[ÙNZP[[\Ú\ËÛZ]ÙXÝ[ÛÏËÙXÝ[Û\X[ÙHÙXÝ[ÛÎZP[[\Ú\ËÛZ]ÙXÝ[ÛÏËÙXÝ[ÛÈ×KNÂËÈZ[RQ]BÛÛÝZYHÂ]Y\NYXÝ]RÙ^]ÛÜÛ\ÜÚYYY[[ZP[[\Ú\Ë[[Û\ÜÚYXØ][ÛËÛ\ÜÚYYY[[[ÜX][Û[Û\ÜÚYYYÝYÙNZP[[\Ú\Ë[[Û\ÜÚYXØ][ÛËÛ\ÜÚYYYÝYÙH]Ø\[\ÜÈX\ÛÛØÛÜNZP[[\Ú\Ë[[Û\ÜÚYXØ][ÛËX\ÛÛØÛÜHK]]Ü]TØÛÜNZP[[\Ú\Ë[[Û\ÜÚYXØ][ÛË]]Ü]TØÛÜHK[[ØÛÜNZP[[\Ú\Ë[[Û\ÜÚYXØ][ÛË[[ØÛÜHK\XÝ[ÛØÛÜNZP[[\Ú\ËintentClassification?.directionScore || 0.5,
      composite: aiAnalysis.intentClassification?.composite || 0.5,
      recommendations: aiAnalysis.intentClassification?.recommendations || [],
    };

    // Build recommendations
    const recommendations = (aiAnalysis.recommendations || []).map((rec) => ({
      module: rec.module || "Content",
      priority: rec.priority || "MEDIUM",
      action: rec.action || "Improve content",
      fix: rec.fix || "Review and improve this area",
      expectedImpact: rec.expectedImpact || "+0.010 composite",
      dataWarehouseSignal: rec.dataWarehouseSignal || "",
    }));

    // Assemble response (backward-compatible with existing frontend)
    const result = {
      url,
      keyword: effectiveKeyword,
      analyzedAt: new Date().toISOString(),
      version: "3.1",
      passed: v2Composite >= 0.6,
      v2Composite: parseFloat(v2Composite.toFixed(4)),
      v1Composite: parseFloat((v2Composite * 0.9).toFixed(4)),
      compositeDelta: parseFloat((v2Composite * 0.1).toFixed(4)),
      predictedRank,
      realGoogleRank,
      realRankData: realRankData || null,
      totalCompetitors: competitors.length,
      wordCount,
      signals,
      competitors,
      navboost,
      smith,
      raid,
      recommendations,
      peopleAlsoAsk,
      // New v3 data
      pageSpeed: pageSpeedData ? {
        lcp: pageSpeedData.lcp,
        cls: pageSpeedData.cls,
        inp: pageSpeedData.inp,
        performanceScore: pageSpeedData.performanceScore,
        seoScore: pageSpeedData.seoScore,
      } : null,
      nlpEntities: nlpEntities ? {
        totalEntities: nlpEntities.totalEntities,
        knowledgeGraphCount: nlpEntities.knowledgeGraphCount,
        topEntities: nlpEntities.entities.slice(0, 10),
      } : null,
      eeat: aiAnalysis.eeatSignals || null,
      informationGain: aiAnalysis.informationGain || null,
      contentFreshness: aiAnalysis.contentFreshness || null,
      serpFeatures: serpData.serpFeatures || [],
    };

    console.log(`[analyze v3.1] Complete! Score: ${(v2Composite * 100).toFixed(1)}/100, Signals: ${signals.length}, Real Rank: ${realGoogleRank || "N/A"}`);

    return res.status(200).json(result);
  } catch (err) {
    console.error("[analyze] Error:", err);
    return res.status(500).json({
      error: err.message || "Analysis failed",
      details: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};
