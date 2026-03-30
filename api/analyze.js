// Content Grader API â Main analysis endpoint
// Orchestrates Firecrawl (scraping) + DataForSEO (SERP) + OpenAI (analysis)

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
      includeTags: ["h1", "h2", "h3", "h4", "h5", "h6", "p", "table", "img", "a", "blockquote", "ul", "ol", "li"],
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
// DataForSEO: SERP results + competitor data
// ============================================================================
async function getSerpResults(keyword) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error("DataForSEO credentials not set");

  const auth = Buffer.from(`${login}:${password}`).toString("base64");

  // Google Organic SERP
  const serpResp = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify([{
      keyword,
      location_code: 2840, // US
      language_code: "en",
      depth: 20,
    }]),
  });

  if (!serpResp.ok) throw new Error(`DataForSEO SERP error: ${serpResp.status}`);
  const serpData = await serpResp.json();

  let organicResults = [];
  let peopleAlsoAsk = [];

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
  }

  return { organicResults, peopleAlsoAsk };
}

async function getDomainMetrics(domains) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  const auth = Buffer.from(`${login}:${password}`).toString("base64");

  // Batch domain rank
  const tasks = domains.slice(0, 15).map((d) => ({ target: d }));

  const resp = await fetch("https://api.dataforseo.com/v3/domain_analytics/whois/overview/live", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(tasks),
  });

  // Also try backlinks summary for domain rank
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
          };
        }
      });
    }
  }

  return domainRanks;
}

// ============================================================================
// OpenAI: Content analysis (entity salience, AI detection, quality, intent)
// ============================================================================
async function analyzeContentWithAI(content, keyword, serpCompetitors, targetDomain) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const truncatedContent = content.substring(0, 12000);
  const competitorList = serpCompetitors
    .slice(0, 5)
    .map((c) => `${c.rank}. ${c.domain} â "${c.title}"`)
    .join("\n");

  const prompt = `You are an expert SEO content analyst. Analyze the following content for the target keyword "${keyword}".

CONTENT (truncated):
${truncatedContent}

TOP SERP COMPETITORS:
${competitorList}

TARGET DOMAIN: ${targetDomain}

Analyze and return a JSON object with these exact fields. Use realistic scores between 0.0 and 1.0:

{
  "entitySalience": {
    "score": <0-1, how prominently the primary entity/keyword appears>,
    "topCompetitorValue": "<string description of best competitor's salience>",
    "yourValue": "<string description of this content's salience>"
  },
  "aiDetection": {
    "score": <0-1, where 1.0 = clearly human, 0.0 = clearly AI>,
    "riskLevel": "<Low risk|Medium risk|High risk>",
    "topCompetitorValue": "Low risk",
    "yourValue": "<the risk level>"
  },
  "contentEffort": {
    "score": <0-1, overall content quality/depth/effort>,
    "topCompetitorValue": "<best competitor score as string>",
    "yourValue": "<this content's score as string>"
  },
  "readabilityGrade": {
    "score": <0-1, where 1.0 = perfect readability>,
    "gradeLevel": "<e.g. Grade 8>"
  },
  "headingDepth": {
    "score": <0-1, quality of heading structure>,
    "maxDepth": <number, deepest heading level used>
  },
  "citationCount": {
    "score": <0-1>,
    "count": <number of citations/references found>,
    "topCompetitorValue": "<string>",
    "yourValue": "<string>"
  },
  "expertQuotes": {
    "score": <0-1>,
    "count": <number of expert quotes found>
  },
  "snippetMatch": {
    "score": <0-1, how well content matches featured snippet patterns>
  },
  "intentClassification": {
    "classifiedIntent": "<Informational|Commercial Investigation|Navigational|Transactional>",
    "classifiedStage": "<Awareness|Consideration|Decision|Action>",
    "reasonScore": <0-1>,
    "authorityScore": <0-1>,
    "intentScore": <0-1>,
    "directionScore": <0-1>,
    "composite": <0-1>,
    "recommendations": ["<string recommendations for better intent alignment>"]
  },
  "navboost": {
    "ctrAttractiveness": <0-1, how clickable the title/meta would be>,
    "satisfactionScore": <0-1, estimated user satisfaction>,
    "pogoStickRisk": <0-1, risk of users bouncing back to SERP>,
    "lastLongestProbability": <0-1, probability this is the last click>,
    "composite": <0-1>
  },
  "smithSections": {
    "sections": [
      {
        "title": "<section heading>",
        "composite": <0-1>,
        "wordCount": <number>,
        "issues": ["<any issues>"]
      }
    ],
    "pageComposite": <0-1>,
    "smithPenalty": <0-1, penalty from weak sections>,
    "sectionVariance": <0-1>,
    "weakestSection": { "title": "<title>", "score": <0-1>, "issues": ["<issues>"] },
    "strongestSection": { "title": "<title>", "score": <0-1> }
  },
  "recommendations": [
    {
      "module": "<RAID|SMITH|NavBoost|Content|Trust|Domain>",
      "priority": "<HIGH|MEDIUM|LOW>",
      "action": "<short action title>",
      "fix": "<detailed explanation of what to fix and why>",
      "expectedImpact": "<e.g. +0.025 composite>"
    }
  ]
}

Be thorough and realistic. Return ONLY valid JSON, no markdown fences.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 4000,
  });

  const text = completion.choices[0].message.content.trim();
  // Strip markdown fences if present
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(cleaned);
}

// ============================================================================
// Signal scoring engine â compute all 18 signals
// ============================================================================
function computeSignals(scrapedData, serpData, aiAnalysis, domainMetrics, targetDomain) {
  const html = scrapedData.html || "";
  const markdown = scrapedData.markdown || "";

  // Count structural elements from HTML
  const imageCount = (html.match(/<img\b/gi) || []).length;
  const tableCount = (html.match(/<table\b/gi) || []).length;
  const internalLinkCount = (html.match(new RegExp(`href=["'][^"']*${escapeRegex(targetDomain)}`, "gi")) || []).length +
    (html.match(/href=["']\//g) || []).length;
  const externalLinkCount = Math.max(0, (html.match(/href=["']https?:\/\//gi) || []).length - internalLinkCount);
  const wordCount = markdown.split(/\s+/).filter(Boolean).length;

  // Get top competitor domain metrics
  const competitorDomains = serpData.organicResults.map((r) => r.domain);
  const topCompDomain = competitorDomains[0] || "unknown";
  const topCompMetrics = domainMetrics[topCompDomain] || { rank: 500, backlinks: 1000 };
  const targetMetrics = domainMetrics[targetDomain] || { rank: 0, backlinks: 0 };

  // Site authority score (based on domain rank)
  const maxRank = Math.max(...Object.values(domainMetrics).map((m) => m.rank || 0), 1);
  const siteAuthorityScore = maxRank > 0 ? Math.min(1, (targetMetrics.rank || 0) / maxRank) : 0.2;

  // PageRank proxy (based on backlinks/referring domains)
  const maxBL = Math.max(...Object.values(domainMetrics).map((m) => m.backlinks || 0), 1);
  const pageRankScore = maxBL > 0 ? Math.min(1, (targetMetrics.backlinks || 0) / maxBL) : 0.3;

  // NSR (keyword diversity) â approximation
  const nsrScore = Math.min(1, wordCount / 5000) * 0.5;

  // Image score
  const topCompImages = 5; // typical top competitor
  const imageScore = Math.min(1, imageCount / Math.max(topCompImages, 1));

  // Table score
  const tableScore = tableCount >= 2 ? 1.0 : tableCount === 1 ? 0.5 : 0.0;

  // Internal links score
  const topCompInternalLinks = 9;
  const internalLinkScore = Math.min(1, internalLinkCount / topCompInternalLinks);

  // External links score
  const externalLinkScore = externalLinkCount >= 3 ? 1.0 : externalLinkCount >= 1 ? 0.5 : 0.0;

  // Build the 18 signals array
  const signals = [
    {
      key: "site_authority", label: "Site Authority",
      score: siteAuthorityScore, weight: 0.09, category: "authority", isNew: false,
      topCompetitor: topCompDomain, topValue: String(topCompMetrics.rank || "N/A"), yourValue: String(targetMetrics.rank || "N/A"),
    },
    {
      key: "entity_salience", label: "Entity Salience",
      score: aiAnalysis.entitySalience?.score || 0.3, weight: 0.09, category: "content", isNew: false,
      topCompetitor: topCompDomain, topValue: aiAnalysis.entitySalience?.topCompetitorValue || "0.7", yourValue: aiAnalysis.entitySalience?.yourValue || "0.3",
    },
    {
      key: "ai_detection", label: "AI Detection",
      score: aiAnalysis.aiDetection?.score || 0.5, weight: 0.038, category: "trust", isNew: false,
      topCompetitor: topCompDomain, topValue: "Low risk", yourValue: aiAnalysis.aiDetection?.yourValue || "Medium risk",
    },
    {
      key: "pagerank0", label: "PageRank",
      score: pageRankScore, weight: 0.06, category: "authority", isNew: false,
      topCompetitor: topCompDomain, topValue: "1.0", yourValue: pageRankScore.toFixed(2),
    },
    {
      key: "nsr", label: "NSR (Keyword Diversity)",
      score: nsrScore, weight: 0.038, category: "authority", isNew: false,
      topCompetitor: topCompDomain, topValue: "1.0", yourValue: nsrScore.toFixed(2),
    },
    {
      key: "content_effort", label: "Content Effort",
      score: aiAnalysis.contentEffort?.score || 0.5, weight: 0.113, category: "content", isNew: false,
      topCompetitor: topCompDomain, topValue: aiAnalysis.contentEffort?.topCompetitorValue || "0.8", yourValue: aiAnalysis.contentEffort?.yourValue || "0.5",
    },
    {
      key: "internal_links", label: "Internal Links",
      score: internalLinkScore, weight: 0.038, category: "engagement", isNew: false,
      topCompetitor: topCompDomain, topValue: `${topCompInternalLinks} links`, yourValue: `${internalLinkCount} links`,
    },
    {
      key: "image_count", label: "Image Count",
      score: imageScore, weight: 0.03, category: "engagement", isNew: false,
      topCompetitor: topCompDomain, topValue: `${topCompImages} images`, yourValue: `${imageCount} image${imageCount !== 1 ? "s" : ""}`,
    },
    {
      key: "table_count", label: "Table Count",
      score: tableScore, weight: 0.023, category: "engagement", isNew: false,
      topCompetitor: topCompDomain, topValue: "3 tables", yourValue: `${tableCount} table${tableCount !== 1 ? "s" : ""}`,
    },
    {
      key: "navboost_proxy", label: "NavBoost CTR",
      score: aiAnalysis.navboost?.composite || 0.5, weight: 0.10, category: "v2", isNew: true,
    },
    {
      key: "smith_composite", label: "SMITH Sections",
      score: aiAnalysis.smithSections?.pageComposite || 0.5, weight: 0.08, category: "v2", isNew: true,
    },
    {
      key: "snippet_match", label: "Snippet Match",
      score: aiAnalysis.snippetMatch?.score || 0.5, weight: 0.038, category: "serp", isNew: false,
    },
    {
      key: "intent_alignment", label: "RAID Intent",
      score: aiAnalysis.intentClassification?.composite || 0.5, weight: 0.07, category: "v2", isNew: true,
    },
    {
      key: "readability_grade", label: "Readability",
      score: aiAnalysis.readabilityGrade?.score || 0.7, weight: 0.038, category: "content", isNew: false,
    },
    {
      key: "heading_depth", label: "Heading Depth",
      score: aiAnalysis.headingDepth?.score || 0.7, weight: 0.023, category: "content", isNew: false,
    },
    {
      key: "citation_count", label: "Citation Count",
      score: aiAnalysis.citationCount?.score || 0.5, weight: 0.075, category: "trust", isNew: false,
      topCompetitor: topCompDomain, topValue: aiAnalysis.citationCount?.topCompetitorValue || "10", yourValue: aiAnalysis.citationCount?.yourValue || "5",
    },
    {
      key: "expert_quotes", label: "Expert Quotes",
      score: aiAnalysis.expertQuotes?.score || 0.5, weight: 0.038, category: "trust", isNew: false,
    },
    {
      key: "external_links", label: "External Links",
      score: externalLinkScore, weight: 0.023, category: "engagement", isNew: false,
    },
  ];

  // Compute impact for each signal (weighted distance from 1.0)
  signals.forEach((s) => {
    s.impact = parseFloat(((1.0 - s.score) * s.weight).toFixed(3));
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
    // Estimate composite based on rank position (higher rank = higher estimated score)
    const rankScore = Math.max(0.3, 1.0 - (r.rank - 1) * 0.03);
    return {
      domain: r.domain,
      rankActual: r.rank,
      compositeScore: parseFloat(rankScore.toFixed(3)),
    };
  });

  // Add target domain
  competitors.push({
    domain: targetDomain,
    rankActual: 0,
    compositeScore: parseFloat(targetComposite.toFixed(3)),
  });

  // Sort by composite descending
  competitors.sort((a, b) => b.compositeScore - a.compositeScore);
  return competitors;
}

// ============================================================================
// Helper
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

    console.log(`[analyze] Starting analysis for ${url} (keyword: "${effectiveKeyword}")`);

    // Step 1: Scrape target URL with Firecrawl
    console.log("[analyze] Scraping URL with Firecrawl...");
    const scrapedData = await scrapeUrl(url);

    // Step 2: Get SERP results from DataForSEO
    console.log("[analyze] Fetching SERP results from DataForSEO...");
    const serpData = await getSerpResults(effectiveKeyword);

    // Step 3: Get domain metrics for all competitors + target
    console.log("[analyze] Fetching domain metrics...");
    const allDomains = [targetDomain, ...serpData.organicResults.map((r) => r.domain)];
    const uniqueDomains = [...new Set(allDomains)];
    const domainMetrics = await getDomainMetrics(uniqueDomains);

    // Step 4: AI analysis with OpenAI
    console.log("[analyze] Running AI analysis with OpenAI...");
    const contentForAI = scrapedData.markdown || scrapedData.html || "";
    const aiAnalysis = await analyzeContentWithAI(contentForAI, effectiveKeyword, serpData.organicResults, targetDomain);

    // Step 5: Compute all 18 signals
    console.log("[analyze] Computing signals...");
    const { signals, v2Composite, wordCount } = computeSignals(scrapedData, serpData, aiAnalysis, domainMetrics, targetDomain);

    // Step 6: Build competitors
    const competitors = buildCompetitors(serpData.organicResults, domainMetrics, targetDomain, v2Composite);

    // Step 7: Determine predicted rank
    const predictedRank = competitors.findIndex((c) => c.domain === targetDomain) + 1;

    // Step 8: Check which PAA questions are answered
    const contentLower = (scrapedData.markdown || "").toLowerCase();
    const peopleAlsoAsk = (serpData.peopleAlsoAsk || []).map((q) => ({
      question: q.question,
      answered: contentLower.includes(q.question.toLowerCase().replace(/[?]/g, "").substring(0, 30)),
    }));

    // Build NavBoost data
    const navboost = aiAnalysis.navboost || {
      ctrAttractiveness: 0.5,
      satisfactionScore: 0.5,
      pogoStickRisk: 0.3,
      lastLongestProbability: 0.4,
      composite: 0.5,
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
    }));

    // Assemble final response matching DEMO_DATA shape exactly
    const result = {
      url,
      keyword: effectiveKeyword,
      analyzedAt: new Date().toISOString(),
      version: "2.0",
      passed: v2Composite >= 0.6,
      v2Composite: parseFloat(v2Composite.toFixed(4)),
      v1Composite: parseFloat((v2Composite * 0.9).toFixed(4)),
      compositeDelta: parseFloat((v2Composite * 0.1).toFixed(4)),
      predictedRank,
      totalCompetitors: competitors.length,
      wordCount,
      signals,
      competitors,
      navboost,
      smith,
      raid,
      recommendations,
      peopleAlsoAsk,
    };

    console.log(`[analyze] Complete! Score: ${(v2Composite * 100).toFixed(1)}/100`);
    return res.status(200).json(result);
  } catch (err) {
    console.error("[analyze] Error:", err);
    return res.status(500).json({
      error: err.message || "Analysis failed",
      details: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};
