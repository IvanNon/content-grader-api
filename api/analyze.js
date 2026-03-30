// Content Grader API v3.2 -- Advanced 34-signal analysis engine
// Warehouse-accurate mappings from seo-datawarehouse.com (2,593 models, 14,027 attributes)
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
    console.warn("[SerpApi] SERPAPI_KEY not set -- skipping real rank lookup");
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
      console.warn(`[SerpApi] HTTP ${resp.status} -- skipping`);
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
    const totalSalience = entities.reduce((s, e) => s + e.salience, 0);
    const knowledgeGraphEntities = entities.filter((e) => e.mid);
    const entityTypes = new Set(entities.map((e) => e.type));

    return {
      entities: entities.slice(0, 20),
      totalEntities: entities.length,
      knowledgeGraphCount: knowledgeGraphEntities.length,
      entityTypeCount: entityTypes.size,
      entityTypes: [...entityTypes],
      topEntity: entities[0] || null,
      avgSalience: entities.length > 0 ? totalSalience / entities.length : 0,
      // Entity coverage: how many entities link to Knowledge Graph
      kgCoverage: entities.length > 0 ? knowledgeGraphEntities.length / entities.length : 0,
    };
  } catch (err) {
    console.warn(`[NLP] Failed: ${err.message}`);
    return null;
  }
}

// ============================================================================
// Google Cloud NLP: Sentiment Analysis
// ============================================================================
async function analyzeSentimentWithNLP(text) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  try {
    const truncated = text.substring(0, 10000);
    const resp = await fetch(
      `https://language.googleapis.com/v1/documents:analyzeSentiment?key=${apiKey}`,
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

    if (!resp.ok) return null;
    const data = await resp.json();

    return {
      documentScore: data.documentSentiment?.score || 0,
      documentMagnitude: data.documentSentiment?.magnitude || 0,
      sentenceCount: data.sentences?.length || 0,
    };
  } catch (err) {
    console.warn(`[NLP Sentiment] Failed: ${err.message}`);
    return null;
  }
}

// ============================================================================
// OpenAI: Enhanced content analysis (expanded for 32 signals)
// Maps to: QualityNSR, NavBoost, SpamBrain, SMITH, Rankembed, SearchPolicyRank
// ============================================================================
async function analyzeContentWithAI(content, keyword, serpCompetitors, targetDomain, nlpEntities, pageSpeedData) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const truncatedContent = content.substring(0, 14000);
  const competitorList = serpCompetitors
    .slice(0, 7)
    .map((c) => `${c.rank}. ${c.domain} -- "${c.title}"`)
    .join("\n");

  // Include NLP entity data if available
  const entityContext = nlpEntities
    ? `\nGOOGLE NLP ENTITIES DETECTED:\n${nlpEntities.entities.slice(0, 10).map(e => `- ${e.name} (${e.type}, salience: ${e.salience.toFixed(3)}, KG: ${e.hasWikipedia})`).join("\n")}\nTotal entities: ${nlpEntities.totalEntities}, KG-linked: ${nlpEntities.knowledgeGraphCount}`
    : "";

  // Include PageSpeed data if available
  const speedContext = pageSpeedData
    ? `\nPAGESPEED DATA:\n- Performance: ${pageSpeedData.performanceScore ? (pageSpeedData.performanceScore * 100).toFixed(0) : "N/A"}/100\n- LCP: ${pageSpeedData.lcp || "N/A"}ms (${pageSpeedData.lcpCategory})\n- CLS: ${pageSpeedData.cls || "N/A"} (${pageSpeedData.clsCategory})\n- INP: ${pageSpeedData.inp || "N/A"}ms (${pageSpeedData.inpCategory})\n- HTTPS: ${pageSpeedData.isHttps}\n- DOM Size: ${pageSpeedData.domSize || "N/A"} elements`
    : "";

  const prompt = `You are an expert SEO content analyst using the Google Content Warehouse API signal framework. Analyze the following content for the target keyword "${keyword}".

CONTENT (truncated):
${truncatedContent}

TOP SERP COMPETITORS:
${competitorList}

TARGET DOMAIN: ${targetDomain}
${entityContext}
${speedContext}

Analyze and return a JSON object with ALL of these fields. Use realistic scores between 0.0 and 1.0:

{
  "entitySalience": {
    "score": <0-1, how prominently the primary entity/keyword appears and is semantically connected>,
    "topCompetitorValue": "<string>",
    "yourValue": "<string>",
    "missingEntities": ["<entities that top competitors likely cover but this content doesn't>"],
    "entityDepth": <0-1, how deeply entities are explored vs surface-level mentions>
  },
  "aiDetection": {
    "score": <0-1, where 1.0 = clearly human-written, 0.0 = clearly AI-generated>,
    "riskLevel": "<Low risk|Medium risk|High risk>",
    "yourValue": "<the risk level>",
    "indicators": ["<specific indicators of AI or human writing>"]
  },
  "contentEffort": {
    "score": <0-1, overall content quality/depth/effort/originality>,
    "topCompetitorValue": "<string>",
    "yourValue": "<string>"
  },
  "readabilityGrade": {
    "score": <0-1, where 1.0 = perfect readability for target audience>,
    "gradeLevel": "<e.g. Grade 8>",
    "avgSentenceLength": <number>
  },
  "headingDepth": {
    "score": <0-1, quality and logical structure of heading hierarchy>,
    "maxDepth": <number>,
    "h1Count": <number>,
    "totalHeadings": <number>
  },
  "citationCount": {
    "score": <0-1>,
    "count": <number of citations/references found>,
    "topCompetitorValue": "<string>",
    "yourValue": "<string>"
  },
  "expertQuotes": {
    "score": <0-1>,
    "count": <number of expert quotes, data points, or original research found>
  },
  "snippetMatch": {
    "score": <0-1, how well content matches featured snippet and PAA patterns>,
    "hasDefinition": <boolean, has a clear definition paragraph>,
    "hasList": <boolean, has structured list/steps>,
    "hasTable": <boolean, has comparison table>
  },
  "intentClassification": {
    "classifiedIntent": "<Informational|Commercial Investigation|Navigational|Transactional>",
    "classifiedStage": "<Awareness|Consideration|Decision|Action>",
    "reasonScore": <0-1>,
    "authorityScore": <0-1>,
    "intentScore": <0-1>,
    "directionScore": <0-1>,
    "composite": <0-1>,
    "recommendations": ["<string recommendations>"]
  },
  "navboost": {
    "ctrAttractiveness": <0-1, how clickable title/meta would be in SERP>,
    "satisfactionScore": <0-1, estimated user satisfaction with content depth>,
    "pogoStickRisk": <0-1, risk of users bouncing back to SERP>,
    "lastLongestProbability": <0-1, probability this is the last click>,
    "dwellTimeEstimate": "<short|medium|long, estimated time user spends>",
    "composite": <0-1>
  },
  "smithSections": {
    "sections": [
      { "title": "<heading>", "composite": <0-1>, "wordCount": <number>, "issues": ["<issues>"] }
    ],
    "pageComposite": <0-1>,
    "smithPenalty": <0-1>,
    "sectionVariance": <0-1>,
    "weakestSection": { "title": "<title>", "score": <0-1>, "issues": ["<issues>"] },
    "strongestSection": { "title": "<title>", "score": <0-1> }
  },
  "informationGain": {
    "score": <0-1, how much unique/original information this content adds beyond what competitors offer>,
    "uniqueAngles": ["<unique perspectives or data points not found in typical SERP results>"],
    "redundancyLevel": "<low|medium|high, how much content repeats what's already in top results>"
  },
  "topicalAuthority": {
    "score": <0-1, how well the domain appears to cover this topic comprehensively>,
    "topicRelevance": <0-1, how relevant is this specific page to the keyword>,
    "contentDepthVsBreadth": "<deep-narrow|balanced|broad-shallow>"
  },
  "eeatSignals": {
    "experience": <0-1, evidence of first-hand experience>,
    "expertise": <0-1, evidence of subject expertise>,
    "authoritativeness": <0-1, evidence of being an authority>,
    "trustworthiness": <0-1, evidence of trustworthiness>,
    "composite": <0-1>,
    "indicators": ["<specific E-E-A-T indicators found>"]
  },
  "contentFreshness": {
    "score": <0-1, how current/fresh the content appears>,
    "hasDatePublished": <boolean>,
    "hasDateModified": <boolean>,
    "referencesCurrentYear": <boolean>,
    "outdatedIndicators": ["<any outdated references found>"]
  },
  "anchorTextRelevance": {
    "score": <0-1, how well internal anchor text and link context relate to the keyword>,
    "descriptiveAnchors": <number, count of descriptive vs generic anchors>,
    "genericAnchors": <number, count of "click here" style anchors>
  },
  "contentGap": {
    "score": <0-1, where 1.0 = covers everything competitors do and more>,
    "missingTopics": ["<topics that competitors likely cover but this content doesn't>"],
    "strengthTopics": ["<topics where this content is stronger than competitors>"]
  },
  "schemaMarkup": {
    "score": <0-1, quality and completeness of structured data/schema>,
    "typesDetected": ["<any schema types found in content, e.g. Article, FAQ, HowTo>"],
    "hasFAQ": <boolean>,
    "hasHowTo": <boolean>,
    "hasArticle": <boolean>
  },
  "titleMatch": {
    "score": <0-1, how well the page title matches the primary keyword and likely search queries>,
    "titleText": "<the actual page title/H1>",
    "keywordInTitle": <boolean, true if primary keyword appears in title>,
    "frontLoaded": <boolean, true if keyword appears in first half of title>,
    "suggestedTitle": "<improved title suggestion if score is low>"
  },
  "pandaRisk": {
    "score": <0-1, inverse of thin content risk -- 1.0 means no Panda risk (substantial content), 0.0 means high Panda risk (thin/low-effort)>,
    "thinContentIndicators": ["<any indicators of thin, low-effort, or auto-generated content>"],
    "depthScore": <0-1, how comprehensive and substantive the content is>,
    "contentToAdRatio": "<high-content|balanced|ad-heavy, ratio of useful content vs boilerplate/ads>"
  },
  "chardQuality": {
    "score": <0-1, overall content quality prediction based on originality, depth, and breadth balance>,
    "originalityScore": <0-1, how unique/original is this content vs typical SERP results>,
    "depthBreadthBalance": "<deep-narrow|balanced|broad-shallow>",
    "substantiveInsights": <number, count of genuinely insightful/non-obvious points in the content>
  },
  "recommendations": [
    {
      "module": "<RAID|SMITH|NavBoost|Content|Trust|Domain|Technical|Entity|E-E-A-T|CWV>",
      "priority": "<HIGH|MEDIUM|LOW>",
      "action": "<short action title>",
      "fix": "<detailed explanation of what to fix and why>",
      "expectedImpact": "<e.g. +0.025 composite>",
      "dataWarehouseSignal": "<the Google Content Warehouse category this maps to>"
    }
  ]
}

Be thorough and realistic. Base scores on actual content analysis, not guesses. Return ONLY valid JSON, no markdown fences.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 6000,
  });

  const text = completion.choices[0].message.content.trim();
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(cleaned);
}

// ============================================================================
// Signal scoring engine -- compute all 32 signals
// Mapped to Google Content Warehouse categories from seo-datawarehouse.com
// ============================================================================
function computeSignals(scrapedData, serpData, aiAnalysis, domainMetrics, targetDomain, pageSpeedData, nlpEntities) {
  const html = scrapedData.html || "";
  const markdown = scrapedData.markdown || "";

  // ---- HTML structural analysis ----
  const imageCount = (html.match(/<img\b/gi) || []).length;
  const imagesWithAlt = (html.match(/<img\b[^>]*alt=["'][^"']+["']/gi) || []).length;
  const tableCount = (html.match(/<table\b/gi) || []).length;
  const internalLinkCount = (html.match(new RegExp(`href=["'][^"']*${escapeRegex(targetDomain)}`, "gi")) || []).length +
    (html.match(/href=["']\//g) || []).length;
  const externalLinkCount = Math.max(0, (html.match(/href=["']https?:\/\//gi) || []).length - internalLinkCount);
  const wordCount = markdown.split(/\s+/).filter(Boolean).length;
  const h1Count = (html.match(/<h1\b/gi) || []).length;
  const h2Count = (html.match(/<h2\b/gi) || []).length;
  const h3Count = (html.match(/<h3\b/gi) || []).length;
  const listCount = (html.match(/<(?:ul|ol)\b/gi) || []).length;
  const blockquoteCount = (html.match(/<blockquote\b/gi) || []).length;
  const hasSchema = html.includes("application/ld+json") || html.includes("itemtype=");
  const videoCount = (html.match(/<(?:video|iframe[^>]*(?:youtube|vimeo))/gi) || []).length;

  // ---- Domain metrics ----
  const competitorDomains = serpData.organicResults.map((r) => r.domain);
  const topCompDomain = competitorDomains[0] || "unknown";
  const topCompMetrics = domainMetrics[topCompDomain] || { rank: 500, backlinks: 1000, referringDomains: 100 };
  const targetMetrics = domainMetrics[targetDomain] || { rank: 0, backlinks: 0, referringDomains: 0 };

  // ---- Compute individual scores ----

  // Site Authority (Quality NSR - 10/10 impact)
  const maxRank = Math.max(...Object.values(domainMetrics).map((m) => m.rank || 0), 1);
  const siteAuthorityScore = maxRank > 0 ? Math.min(1, (targetMetrics.rank || 0) / maxRank) : 0.2;

  // PageRank proxy (Kaltix - 10/10 impact)
  const maxBL = Math.max(...Object.values(domainMetrics).map((m) => m.backlinks || 0), 1);
  const pageRankScore = maxBL > 0 ? Math.min(1, (targetMetrics.backlinks || 0) / maxBL) : 0.3;

  // Referring domain diversity (Anchors - 9/10 impact)
  const maxRD = Math.max(...Object.values(domainMetrics).map((m) => m.referringDomains || 0), 1);
  const referringDomainScore = maxRD > 0 ? Math.min(1, (targetMetrics.referringDomains || 0) / maxRD) : 0.2;

  // Image optimization score
  const imageScore = imageCount === 0 ? 0 : Math.min(1, imageCount / 6);
  const imageAltScore = imageCount > 0 ? imagesWithAlt / imageCount : 0;

  // Internal links
  const internalLinkScore = Math.min(1, internalLinkCount / 10);

  // External links
  const externalLinkScore = externalLinkCount >= 5 ? 1.0 : externalLinkCount >= 3 ? 0.7 : externalLinkCount >= 1 ? 0.4 : 0.0;

  // Table score
  const tableScore = tableCount >= 2 ? 1.0 : tableCount === 1 ? 0.6 : 0.0;

  // ---- Core Web Vitals scores (CompressedQualitySignals - 10/10 impact) ----
  let cwvScore = 0.5; // default if no data
  let performanceScore = 0.5;
  let mobileFriendlyScore = 0.5;
  let httpsScore = 1.0;

  if (pageSpeedData) {
    // CWV composite: LCP + CLS + INP
    const lcpScore = pageSpeedData.lcpCategory === "FAST" ? 1.0 : pageSpeedData.lcpCategory === "AVERAGE" ? 0.6 : 0.3;
    const clsScore = pageSpeedData.clsCategory === "FAST" ? 1.0 : pageSpeedData.clsCategory === "AVERAGE" ? 0.6 : 0.3;
    const inpScore = pageSpeedData.inpCategory === "FAST" ? 1.0 : pageSpeedData.inpCategory === "AVERAGE" ? 0.6 : 0.3;
    cwvScore = (lcpScore * 0.4 + clsScore * 0.3 + inpScore * 0.3);

    performanceScore = pageSpeedData.performanceScore || 0.5;
    httpsScore = pageSpeedData.isHttps ? 1.0 : 0.0;

    // Mobile-friendliness from tap targets + font sizes
    const tapScore = pageSpeedData.tapTargets || 0.5;
    const fontScore = pageSpeedData.fontSizes || 0.5;
    mobileFriendlyScore = (tapScore + fontScore) / 2;
  }

  // ---- NLP Entity scores (RepositoryWebref - 7/10 impact) ----
  let entityKGScore = 0.5;
  let entityDiversityScore = 0.5;
  if (nlpEntities) {
    entityKGScore = Math.min(1, nlpEntities.kgCoverage * 2); // Reward KG-linked entities
    entityDiversityScore = Math.min(1, nlpEntities.entityTypeCount / 8); // Diversity of entity types
  }

  // ---- NSR (site-level quality proxy) ----
  const nsrScore = Math.min(1, (siteAuthorityScore * 0.4 + referringDomainScore * 0.3 + (aiAnalysis.topicalAuthority?.score || 0.3) * 0.3));

  // ---- Content structure score ----
  const structureElements = Math.min(1, (listCount + tableCount + blockquoteCount + videoCount) / 8);

  // ---- People Also Ask coverage ----
  const contentLower = markdown.toLowerCase();
  const paaAnswered = (serpData.peopleAlsoAsk || []).filter(q =>
    contentLower.includes(q.question.toLowerCase().replace(/[?]/g, "").substring(0, 30))
  ).length;
  const paaTotal = Math.max(serpData.peopleAlsoAsk?.length || 1, 1);
  const paaCoverageScore = Math.min(1, paaAnswered / paaTotal);

  // ---- Title Match score (QualityNsrNsrData.titlematchScore) ----
  const titleMatchComputed = (() => {
    const titleText = aiAnalysis.titleMatch?.titleText || "";
    const kwInTitle = aiAnalysis.titleMatch?.keywordInTitle || false;
    const kwFrontLoaded = aiAnalysis.titleMatch?.frontLoaded || false;
    if (kwInTitle && kwFrontLoaded) return 0.95;
    if (kwInTitle) return 0.75;
    return aiAnalysis.titleMatch?.score || 0.4;
  })();

  // ---- Panda Risk score (CompressedQualitySignals.pandaDemotion) ----
  const pandaRiskComputed = (() => {
    const wordCountFactor = wordCount < 300 ? 0.2 : wordCount < 600 ? 0.4 : wordCount < 1000 ? 0.65 : 0.85;
    const structureFactor = (listCount + tableCount + blockquoteCount) > 2 ? 0.8 : (listCount + tableCount) > 0 ? 0.5 : 0.2;
    const depthFactor = aiAnalysis.pandaRisk?.depthScore || aiAnalysis.contentEffort?.score || 0.5;
    return Math.min(1, wordCountFactor * 0.35 + structureFactor * 0.25 + depthFactor * 0.4);
  })();

  // ---- Chard Quality score (QualityNsrNsrData.chardEncoded) ----
  const chardQualityComputed = (() => {
    const originality = aiAnalysis.chardQuality?.originalityScore || aiAnalysis.informationGain?.score || 0.4;
    const balance = aiAnalysis.chardQuality?.depthBreadthBalance || "broad-shallow";
    const balanceScore = balance === "balanced" ? 0.9 : balance === "deep-narrow" ? 0.75 : 0.4;
    const substantive = Math.min(1, (aiAnalysis.chardQuality?.substantiveInsights || 3) / 8);
    return Math.min(1, originality * 0.4 + balanceScore * 0.3 + substantive * 0.3);
  })();

  // ============================================
  // BUILD THE 34 SIGNALS ARRAY
  // Mapped to Google Content Warehouse API modules (seo-datawarehouse.com)
  // ============================================
  const signals = [
    // === TIER 1: NavBoost (10/10 impact) ===
    {
      key: "navboost_ctr", label: "NavBoost: CTR Attractiveness",
      score: aiAnalysis.navboost?.ctrAttractiveness || 0.5, weight: 0.055, category: "navboost", isNew: true,
      dataWarehouse: "QualityNavboostCrapsCrapsClickSignals (clicks, goodClicks, impressions)",
      topCompetitor: topCompDomain,
    },
    {
      key: "navboost_satisfaction", label: "NavBoost: User Satisfaction",
      score: aiAnalysis.navboost?.satisfactionScore || 0.5, weight: 0.05, category: "navboost", isNew: true,
      dataWarehouse: "QualityNavboostCrapsCrapsData",
    },
    {
      key: "navboost_pogostick", label: "NavBoost: Pogo-Stick Risk",
      score: 1.0 - (aiAnalysis.navboost?.pogoStickRisk || 0.5), weight: 0.045, category: "navboost", isNew: true,
      dataWarehouse: "QualityNavboostCrapsCrapsClickSignals (lastLongestClicks)",
    },

    // === TIER 2: Quality NSR / Site Authority (10/10 impact) ===
    {
      key: "site_authority", label: "Site Authority (NSR)",
      score: siteAuthorityScore, weight: 0.07, category: "authority", isNew: false,
      dataWarehouse: "QualityNsrNsrData",
      topCompetitor: topCompDomain, topValue: String(topCompMetrics.rank || "N/A"), yourValue: String(targetMetrics.rank || "N/A"),
    },
    {
      key: "nsr_topical", label: "Topical Authority",
      score: aiAnalysis.topicalAuthority?.score || 0.4, weight: 0.045, category: "authority", isNew: true,
      dataWarehouse: "QualityNsrNsrChunksProto",
    },
    {
      key: "pagerank0", label: "PageRank (Kaltix)",
      score: pageRankScore, weight: 0.05, category: "authority", isNew: false,
      dataWarehouse: "KaltixPerDocData",
      topCompetitor: topCompDomain, topValue: "1.0", yourValue: pageRankScore.toFixed(2),
    },
    {
      key: "referring_domains", label: "Referring Domain Diversity",
      score: referringDomainScore, weight: 0.04, category: "authority", isNew: true,
      dataWarehouse: "AnchorsAnchorSource",
      topCompetitor: topCompDomain,
      topValue: String(topCompMetrics.referringDomains || "N/A"),
      yourValue: String(targetMetrics.referringDomains || "N/A"),
    },

    // === TIER 3: Content Quality (SMITH, Rankembed, CompressedQuality) ===
    {
      key: "content_effort", label: "Content Effort & Depth",
      score: aiAnalysis.contentEffort?.score || 0.5, weight: 0.065, category: "content", isNew: false,
      dataWarehouse: "CompressedQualitySignals",
      topCompetitor: topCompDomain, topValue: aiAnalysis.contentEffort?.topCompetitorValue || "0.8", yourValue: aiAnalysis.contentEffort?.yourValue || "0.5",
    },
    {
      key: "smith_composite", label: "SMITH Section Quality",
      score: aiAnalysis.smithSections?.pageComposite || 0.5, weight: 0.055, category: "content", isNew: true,
      dataWarehouse: "QualityRankembedMustangMustangRankEmbedInfo",
    },
    {
      key: "information_gain", label: "Information Gain",
      score: aiAnalysis.informationGain?.score || 0.4, weight: 0.05, category: "content", isNew: true,
      dataWarehouse: "InformationGainScore (Patent US20200349181A1)",
    },
    {
      key: "entity_salience", label: "Entity Salience & KG Coverage",
      score: nlpEntities ? Math.min(1, (aiAnalysis.entitySalience?.score || 0.3) * 0.6 + entityKGScore * 0.4) : (aiAnalysis.entitySalience?.score || 0.3), weight: 0.055, category: "content", isNew: false,
      dataWarehouse: "QualitySalientTermsDocData + RepositoryWebrefAnnotatedCategoryInfo",
      topCompetitor: topCompDomain, topValue: aiAnalysis.entitySalience?.topCompetitorValue || "0.7", yourValue: aiAnalysis.entitySalience?.yourValue || "0.3",
    },
    {
      key: "readability_grade", label: "Readability",
      score: aiAnalysis.readabilityGrade?.score || 0.7, weight: 0.03, category: "content", isNew: false,
    },
    {
      key: "heading_depth", label: "Heading Structure",
      score: aiAnalysis.headingDepth?.score || 0.7, weight: 0.025, category: "content", isNew: false,
    },
    {
      key: "content_structure", label: "Content Structure (Lists/Tables/Media)",
      score: structureElements, weight: 0.025, category: "content", isNew: true,
      dataWarehouse: "QualityPreviewChosenSnippetInfo",
    },

    // === TIER 4: Trust & E-E-A-T (SpamBrain - 10/10 impact) ===
    {
      key: "eeat_composite", label: "E-E-A-T Composite",
      score: aiAnalysis.eeatSignals?.composite || 0.5, weight: 0.055, category: "trust", isNew: true,
      dataWarehouse: "SpamBrainData",
    },
    {
      key: "ai_detection", label: "AI Detection (Human Score)",
      score: aiAnalysis.aiDetection?.score || 0.5, weight: 0.03, category: "trust", isNew: false,
      dataWarehouse: "SpamMuppetjoinsMuppetSignals",
      topCompetitor: topCompDomain, topValue: "Low risk", yourValue: aiAnalysis.aiDetection?.yourValue || "Medium risk",
    },
    {
      key: "citation_count", label: "Citations & References",
      score: aiAnalysis.citationCount?.score || 0.5, weight: 0.04, category: "trust", isNew: false,
      topCompetitor: topCompDomain, topValue: aiAnalysis.citationCount?.topCompetitorValue || "10", yourValue: aiAnalysis.citationCount?.yourValue || "5",
    },
    {
      key: "expert_quotes", label: "Expert Quotes & Original Data",
      score: aiAnalysis.expertQuotes?.score || 0.5, weight: 0.03, category: "trust", isNew: false,
    },

    // === TIER 5: Technical / Core Web Vitals (CompressedQuality, Indexing - 9-10/10) ===
    {
      key: "cwv_composite", label: "Core Web Vitals",
      score: cwvScore, weight: 0.04, category: "technical", isNew: true,
      dataWarehouse: "CompressedQualitySignals",
    },
    {
      key: "page_performance", label: "Page Performance Score",
      score: performanceScore, weight: 0.03, category: "technical", isNew: true,
      dataWarehouse: "CrawlerChangerateUrlChange",
    },
    {
      key: "mobile_friendly", label: "Mobile Friendliness",
      score: mobileFriendlyScore, weight: 0.025, category: "technical", isNew: true,
      dataWarehouse: "IndexingMobileInterstitialsProto",
    },
    {
      key: "https_security", label: "HTTPS Security",
      score: httpsScore, weight: 0.015, category: "technical", isNew: true,
    },
    {
      key: "schema_markup", label: "Schema/Structured Data",
      score: aiAnalysis.schemaMarkup?.score || (hasSchema ? 0.7 : 0.1), weight: 0.025, category: "technical", isNew: true,
      dataWarehouse: "QualityRichsnippetsAppsProtosLaunchAppInfoPerDocData",
    },

    // === TIER 6: SERP Alignment & Engagement ===
    {
      key: "intent_alignment", label: "RAID Intent Alignment",
      score: aiAnalysis.intentClassification?.composite || 0.5, weight: 0.05, category: "serp", isNew: true,
      dataWarehouse: "SearchPolicyRankableSensitivity",
    },
    {
      key: "snippet_match", label: "Featured Snippet Match",
      score: aiAnalysis.snippetMatch?.score || 0.5, weight: 0.03, category: "serp", isNew: false,
      dataWarehouse: "QualityPreviewRanklabSnippet",
    },
    {
      key: "paa_coverage", label: "People Also Ask Coverage",
      score: paaCoverageScore, weight: 0.025, category: "serp", isNew: true,
    },
    {
      key: "content_gap", label: "Competitive Content Gap",
      score: aiAnalysis.contentGap?.score || 0.5, weight: 0.035, category: "serp", isNew: true,
    },
    {
      key: "content_freshness", label: "Content Freshness",
      score: aiAnalysis.contentFreshness?.score || 0.5, weight: 0.03, category: "serp", isNew: true,
      dataWarehouse: "QualityTimebasedLastSignificantUpdate + CrawlerChangerateUrlChange",
    },

    // === Link & Engagement Signals ===
    {
      key: "internal_links", label: "Internal Link Quality",
      score: internalLinkScore, weight: 0.025, category: "engagement", isNew: false,
      dataWarehouse: "IndexingDocjoinerAnchorStatistics",
      topCompetitor: topCompDomain, topValue: "10 links", yourValue: `${internalLinkCount} links`,
    },
    {
      key: "external_links", label: "External Link Quality",
      score: externalLinkScore, weight: 0.02, category: "engagement", isNew: false,
    },
    {
      key: "image_optimization", label: "Image Optimization",
      score: imageCount === 0 ? 0 : (imageScore * 0.5 + imageAltScore * 0.5), weight: 0.02, category: "engagement", isNew: true,
      dataWarehouse: "ImageQualityNavboostImageQualityClickSignals",
    },

    // === NEW v3.2: Title, Panda, Chard Quality Signals ===
    {
      key: "title_match", label: "Title-Query Match",
      score: aiAnalysis.titleMatch?.score || titleMatchComputed, weight: 0.035, category: "content", isNew: true,
      dataWarehouse: "QualityNsrNsrData (titlematchScore)",
    },
    {
      key: "panda_risk", label: "Panda Thin Content Risk",
      score: aiAnalysis.pandaRisk?.score || pandaRiskComputed, weight: 0.04, category: "content", isNew: true,
      dataWarehouse: "CompressedQualitySignals (pandaDemotion, babyPandaV2Demotion)",
    },
    {
      key: "chard_quality", label: "Content Quality (Chard Predictor)",
      score: aiAnalysis.chardQuality?.score || chardQualityComputed, weight: 0.035, category: "content", isNew: true,
      dataWarehouse: "QualityNsrNsrData (chardEncoded, tofu)",
    },
  ];

  // Compute impact for each signal
  signals.forEach((s) => {
    s.impact = parseFloat(((1.0 - s.score) * s.weight).toFixed(4));
    s.status = s.score >= 0.7 ? "strong" : s.score >= 0.4 ? "moderate" : "weak";
  });

  // Sort by impact descending
  signals.sort((a, b) => b.impact - a.impact);

  // Composite score
  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const v2Composite = signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight;

  return { signals, v2Composite, wordCount };
}

// ============================================================================
// Build competitors array
// ============================================================================
function buildCompetitors(serpResults, domainMetrics, targetDomain, targetComposite) {
  const competitors = serpResults.map((r) => {
    const metrics = domainMetrics[r.domain] || {};
    const rankScore = Math.max(0.3, 1.0 - (r.rank - 1) * 0.03);
    return {
      domain: r.domain,
      rankActual: r.rank,
      compositeScore: parseFloat(rankScore.toFixed(3)),
    };
  });

  competitors.push({
    domain: targetDomain,
    rankActual: 0,
    compositeScore: parseFloat(targetComposite.toFixed(3)),
  });

  competitors.sort((a, b) => b.compositeScore - a.compositeScore);
  return competitors;
}

// ============================================================================
// Helpers
// ============================================================================
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Main handler
// ============================================================================
module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { url, keyword } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    const targetDomain = extractDomain(url);
    const effectiveKeyword = keyword || targetDomain.split(".")[0];

    console.log(`[analyze v3.2] Starting 34-signal analysis for ${url} (keyword: "${effectiveKeyword}")`);

    // Step 1: Fire off parallel API calls for speed
    console.log("[analyze] Starting parallel API calls...");

    const [scrapedData, serpData, pageSpeedData, realRankData] = await Promise.all([
      scrapeUrl(url),
      getSerpResults(effectiveKeyword),
      getPageSpeedData(url).catch((e) => { console.warn("[PageSpeed] Skipped:", e.message); return null; }),
      getRealGoogleRank(effectiveKeyword, url).catch((e) => { console.warn("[SerpApi] Skipped:", e.message); return null; }),
    ]);

    // Step 2: Domain metrics (needs SERP results first)
    console.log("[analyze] Fetching domain metrics...");
    const allDomains = [targetDomain, ...serpData.organicResults.map((r) => r.domain)];
    const uniqueDomains = [...new Set(allDomains)];
    const domainMetrics = await getDomainMetrics(uniqueDomains);

    // Step 3: NLP entity + sentiment analysis (parallel)
    console.log("[analyze] Running NLP entity & sentiment analysis...");
    const contentText = scrapedData.markdown || scrapedData.html || "";

    const [nlpEntities, nlpSentiment] = await Promise.all([
      analyzeEntitiesWithNLP(contentText).catch((e) => { console.warn("[NLP Entity] Skipped:", e.message); return null; }),
      analyzeSentimentWithNLP(contentText).catch((e) => { console.warn("[NLP Sentiment] Skipped:", e.message); return null; }),
    ]);

    // Step 4: AI analysis with OpenAI (enriched with NLP + PageSpeed data)
    console.log("[analyze] Running AI analysis with OpenAI...");
    const aiAnalysis = await analyzeContentWithAI(contentText, effectiveKeyword, serpData.organicResults, targetDomain, nlpEntities, pageSpeedData);

    // Step 5: Compute all 32 signals
    console.log("[analyze] Computing 34 signals...");
    const { signals, v2Composite, wordCount } = computeSignals(scrapedData, serpData, aiAnalysis, domainMetrics, targetDomain, pageSpeedData, nlpEntities);

    // Step 6: Build competitors
    const competitors = buildCompetitors(serpData.organicResults, domainMetrics, targetDomain, v2Composite);

    // Step 7: Predicted rank (among scraped competitors) + Real Google rank (via SerpApi)
    const predictedRank = competitors.findIndex((c) => c.domain === targetDomain) + 1;
    const realGoogleRank = realRankData?.realRank || null;

    // Step 8: PAA coverage
    const contentLower = (scrapedData.markdown || "").toLowerCase();
    const peopleAlsoAsk = (serpData.peopleAlsoAsk || []).map((q) => ({
      question: q.question,
      answered: contentLower.includes(q.question.toLowerCase().replace(/[?]/g, "").substring(0, 30)),
    }));

    // Build NavBoost data
    const navboost = aiAnalysis.navboost || {
      ctrAttractiveness: 0.5, satisfactionScore: 0.5,
      pogoStickRisk: 0.3, lastLongestProbability: 0.4, composite: 0.5,
    };

    // Build SMITH data
    const smith = {
      sectionCount: aiAnalysis.smithSections?.sections?.length || 0,
      pageComposite: aiAnalysis.smithSections?.pageComposite || 0.5,
      smithPenalty: aiAnalysis.smithSections?.smithPenalty || 0,
      weakestSection: aiAnalysis.smithSections?.weakestSection || { title: "N/A", score: 0.5, issues: [] },
      strongestSection: aiAnalysis.smithSections?.strongestSection || { title: "N/A", score: 0.8 },
      sectionVariance: aiAnalysis.smithSections?.sectionVariance || 0,
      sections: aiAnalysis.smithSections?.sections || [],
    };

    // Build RAID data
    const raid = {
      query: effectiveKeyword,
      classifiedIntent: aiAnalysis.intentClassification?.classifiedIntent || "Informational",
      classifiedStage: aiAnalysis.intentClassification?.classifiedStage || "Awareness",
      reasonScore: aiAnalysis.intentClassification?.reasonScore || 0.5,
      authorityScore: aiAnalysis.intentClassification?.authorityScore || 0.5,
      intentScore: aiAnalysis.intentClassification?.intentScore || 0.5,
      directionScore: aiAnalysis.intentClassification?.directionScore || 0.5,
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
      version: "3.2",
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
      titleMatch: aiAnalysis.titleMatch || null,
      pandaRisk: aiAnalysis.pandaRisk || null,
      chardQuality: aiAnalysis.chardQuality || null,
      serpFeatures: serpData.serpFeatures || [],
    };

    console.log(`[analyze v3.2] Complete! Score: ${(v2Composite * 100).toFixed(1)}/100, Signals: ${signals.length}, Real Rank: ${realGoogleRank || "N/A"}`);

    return res.status(200).json(result);
  } catch (err) {
    console.error("[analyze] Error:", err);
    return res.status(500).json({
      error: err.message || "Analysis failed",
      details: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};
