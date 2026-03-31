// Content Grader API v3.2 — Auto-Optimization Loop
// POST /api/optimize
// Receives: content, keyword, round (1-3), signals, frozenData
// Returns: optimizedContent, newSignals, changeLog, scoreDelta

const { OpenAI } = require("openai");

// CORS handler
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Frozen signals that should never be recomputed (site-level or external metrics)
const FROZEN_SIGNALS = [
  "site_authority",
  "pagerank0",
  "referring_domains",
  "cwv_composite",
  "page_performance",
  "mobile_friendly",
  "https_security",
  "nsr_topical"
];

// All 34 signals with metadata
const SIGNAL_METADATA = {
  navboost_ctr: { label: "NavBoost CTR", category: "engagement", warehouseModule: "NavBoost" },
  navboost_satisfaction: { label: "NavBoost Satisfaction", category: "engagement", warehouseModule: "NavBoost" },
  navboost_pogostick: { label: "NavBoost Pogostick Risk", category: "engagement", warehouseModule: "NavBoost" },
  site_authority: { label: "Site Authority", category: "domain", warehouseModule: "AuthorityHub" },
  nsr_topical: { label: "Topical Authority (NSR)", category: "domain", warehouseModule: "NSR" },
  pagerank0: { label: "PageRank", category: "domain", warehouseModule: "PageRank" },
  referring_domains: { label: "Referring Domains", category: "domain", warehouseModule: "LinkGraph" },
  content_effort: { label: "Content Effort", category: "content", warehouseModule: "Panda" },
  smith_composite: { label: "SMITH Score", category: "content", warehouseModule: "SMITH" },
  information_gain: { label: "Information Gain", category: "content", warehouseModule: "InformationRelevance" },
  entity_salience: { label: "Entity Salience", category: "content", warehouseModule: "EntitySalience" },
  readability_grade: { label: "Readability Grade", category: "content", warehouseModule: "ReadabilityMetrics" },
  heading_depth: { label: "Heading Structure", category: "structure", warehouseModule: "SMITH" },
  content_structure: { label: "Content Structure", category: "structure", warehouseModule: "SMITH" },
  eeat_composite: { label: "E-E-A-T Score", category: "authority", warehouseModule: "EEATModule" },
  ai_detection: { label: "AI Detection Risk", category: "quality", warehouseModule: "AIDetection" },
  citation_count: { label: "Citation Count", category: "authority", warehouseModule: "CitationGraph" },
  expert_quotes: { label: "Expert Quotes", category: "authority", warehouseModule: "ExpertDetection" },
  cwv_composite: { label: "Core Web Vitals", category: "ux", warehouseModule: "CWV" },
  page_performance: { label: "Page Speed", category: "ux", warehouseModule: "PageSpeed" },
  mobile_friendly: { label: "Mobile Friendly", category: "ux", warehouseModule: "MobileUsability" },
  https_security: { label: "HTTPS/Security", category: "security", warehouseModule: "SecuritySignals" },
  schema_markup: { label: "Schema Markup", category: "structure", warehouseModule: "SchemaMarkup" },
  intent_alignment: { label: "Intent Alignment", category: "relevance", warehouseModule: "IntentMatcher" },
  snippet_match: { label: "Snippet Match", category: "serp", warehouseModule: "SnippetOptimization" },
  paa_coverage: { label: "PAA Coverage", category: "content", warehouseModule: "PAA" },
  content_gap: { label: "Competitive Content Gap", category: "content", warehouseModule: "ContentGap" },
  content_freshness: { label: "Content Freshness", category: "quality", warehouseModule: "FreshnessSignal" },
  internal_links: { label: "Internal Linking", category: "structure", warehouseModule: "LinkGraph" },
  external_links: { label: "Outbound Links", category: "authority", warehouseModule: "LinkGraph" },
  image_optimization: { label: "Image Optimization", category: "ux", warehouseModule: "ImageSignals" },
  title_match: { label: "Title Match", category: "relevance", warehouseModule: "QueryUnderstanding" },
  panda_risk: { label: "Panda Risk (Low Quality)", category: "quality", warehouseModule: "Panda" },
  chard_quality: { label: "CHARD Quality", category: "quality", warehouseModule: "CHARD" }
};

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      content,
      keyword,
      round,
      targetScore,
      currentScore,
      signals,
      serpData,
      competitorInsights,
      frozenData,
      previousRounds
    } = req.body;

    // Validate inputs
    if (!content?.markdown || !keyword) {
      return res.status(400).json({ error: "content.markdown and keyword are required" });
    }
    if (round < 1 || round > 3) {
      return res.status(400).json({ error: "round must be 1, 2, or 3" });
    }

    // 1. Build round-specific GPT-4 prompt
    const systemPrompt = buildRoundPrompt(
      round,
      signals,
      keyword,
      competitorInsights,
      serpData,
      previousRounds
    );

    // 2. Call GPT-4o to optimize content
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const optimizedMarkdown = await optimizeContent(
      openai,
      systemPrompt,
      content.markdown,
      keyword,
      round
    );

    // 3. Re-score the optimized content using GPT-4o analysis
    const newAiAnalysis = await reAnalyzeContent(
      openai,
      optimizedMarkdown,
      keyword,
      serpData?.organicResults || []
    );

    // 4. Compute new signals (content-based only, frozen signals stay the same)
    const { newSignals, newScore } = recomputeSignals(
      signals,
      newAiAnalysis,
      optimizedMarkdown,
      keyword,
      frozenData
    );

    // 5. Build change log with warehouse attribution
    const changeLog = buildChangeLog(signals, newSignals, round);

    // 6. Determine if target reached
    const targetReached = newScore * 100 >= (targetScore || 80);
    const canContinue = round < 3 && !targetReached;

    // 7. Build next round strategy
    const nextRoundStrategy = canContinue ? getNextRoundStrategy(round + 1) : null;

    return res.status(200).json({
      optimizedContent: { markdown: optimizedMarkdown },
      newScore: parseFloat((newScore * 100).toFixed(1)),
      previousScore: parseFloat(currentScore.toFixed(1)),
      scoreDelta: `+${((newScore * 100) - currentScore).toFixed(1)}`,
      round,
      targetReached,
      signals: categorizeSignalChanges(signals, newSignals),
      changeLog,
      frozenSignalNote: getFrozenNote(newSignals),
      nextRoundStrategy,
      canContinue
    });
  } catch (err) {
    console.error("[optimize] Error:", err);
    return res.status(500).json({ error: err.message || "Optimization failed" });
  }
};

// Build round-specific optimization prompt
function buildRoundPrompt(round, signals, keyword, competitorInsights, serpData, previousRounds) {
  let focus = "";
  let targets = [];

  if (round === 1) {
    focus = "STRUCTURE & QUICK WINS";
    targets = [
      "smith_composite",
      "content_structure",
      "heading_depth",
      "schema_markup",
      "title_match",
      "paa_coverage",
      "snippet_match"
    ];
  } else if (round === 2) {
    focus = "DEPTH & AUTHORITY";
    targets = [
      "content_effort",
      "eeat_composite",
      "information_gain",
      "citation_count",
      "expert_quotes",
      "content_gap",
      "entity_salience",
      "chard_quality",
      "panda_risk"
    ];
  } else {
    focus = "INTENT & ENGAGEMENT";
    targets = [
      "intent_alignment",
      "navboost_ctr",
      "navboost_satisfaction",
      "ai_detection",
      "content_freshness",
      "readability_grade",
      "entity_salience",
      "external_links",
      "image_optimization"
    ];
  }

  // Build signal context
  let signalContext = "Current target signal scores:\n";
  targets.forEach((key) => {
    const score = signals[key] || 0;
    const label = SIGNAL_METADATA[key]?.label || key;
    const module = SIGNAL_METADATA[key]?.warehouseModule || "Unknown";
    signalContext += `- ${label} (${module}): ${(score * 100).toFixed(1)}/100\n`;
  });

  // Add competitor insights if available
  let competitorContext = "";
  if (competitorInsights && competitorInsights.gaps && competitorInsights.gaps.length > 0) {
    competitorContext = "\nCompetitor content gaps to address:\n";
    competitorInsights.gaps.slice(0, 5).forEach((gap) => {
      competitorContext += `- ${gap}\n`;
    });
  }

  // Add PAA questions if available
  let paaContext = "";
  if (serpData?.paaQuestions && serpData.paaQuestions.length > 0) {
    paaContext = "\nPeople Also Ask (PAA) questions to address:\n";
    serpData.paaQuestions.slice(0, 5).forEach((q) => {
      paaContext += `- ${q}\n`;
    });
  }

  // Summarize previous rounds
  let previousContext = "";
  if (previousRounds && previousRounds.length > 0) {
    previousContext = "\nPrevious optimization rounds:\n";
    previousRounds.forEach((pr, idx) => {
      previousContext += `Round ${idx + 1}: ${pr.changeSummary || "Improvements made"}\n`;
    });
  }

  return `You are a content optimization expert focused on ${focus} for Google search ranking.

Your task is to optimize the provided markdown content to improve the following metrics:
${signalContext}${competitorContext}${paaContext}${previousContext}

Guidelines for Round ${round}:
${round === 1
    ? `- Improve structural clarity: use H2/H3 hierarchy, short paragraphs (2-3 sentences max)
- Add schema markup hints (wrap key entities and dates in emphasis)
- Expand title and intro to fully match search intent for "${keyword}"
- Ensure featured snippet optimization: answer common questions in first 40 words of sections
- Address PAA questions with dedicated subsections
- Improve heading depth and clarity`
    : round === 2
    ? `- Increase content effort: add depth, nuance, and substantive information
- Improve E-E-A-T: add expert credibility, citations, and quotes from authorities
- Address competitive content gaps identified by competitors
- Increase entity salience: mention related entities, concepts, and context
- Reduce Panda risk: remove thin content, fluff, and promotional language
- Improve CHARD quality: ensure substantive, helpful, comprehensive content`
    : `- Optimize for intent: ensure content fully matches the query intent
- Improve readability: vary sentence length, use active voice, reduce jargon
- Boost NavBoost engagement: write compelling meta descriptions and improve CTR potential
- Address AI detection: make content more human, add personal insights and anecdotes
- Improve freshness signals: update data, add recent examples, include current context
- Optimize images: ensure they're relevant and well-captioned
- Increase external authority links to related, authoritative sources`
}

Output only the optimized markdown. Do not include any explanations or metadata.`;
}

// Call GPT-4o to optimize content
async function optimizeContent(openai, systemPrompt, markdown, keyword, round) {
  const temperature = round === 1 ? 0.4 : 0.5;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Optimize this markdown content for the keyword "${keyword}":\n\n${markdown}`
      }
    ]
  });

  return response.choices[0].message.content.trim();
}

// Re-analyze content with simplified AI scoring (content-based only)
async function reAnalyzeContent(openai, content, keyword, serpCompetitors) {
  const snippets = serpCompetitors
    .map((c) => `- ${c.title}: ${c.snippet}`)
    .join("\n");

  const analysisPrompt = `Analyze this content and score it on key SEO signals (0-100 scale). Return a JSON object with these scores:
{
  "smith_composite": <0-100>,
  "content_structure": <0-100>,
  "heading_depth": <0-100>,
  "eeat_composite": <0-100>,
  "information_gain": <0-100>,
  "entity_salience": <0-100>,
  "content_effort": <0-100>,
  "readability_grade": <0-100>,
  "schema_markup": <0-100>,
  "intent_alignment": <0-100>,
  "snippet_match": <0-100>,
  "paa_coverage": <0-100>,
  "content_gap": <0-100>,
  "content_freshness": <0-100>,
  "ai_detection": <0-100>,
  "citation_count": <0-100>,
  "expert_quotes": <0-100>,
  "title_match": <0-100>,
  "panda_risk": <100-0>,
  "chard_quality": <0-100>,
  "internal_links": <0-100>,
  "external_links": <0-100>,
  "image_optimization": <0-100>,
  "navboost_ctr": <0-100>,
  "navboost_satisfaction": <0-100>
}

Content to analyze:
${content}

Competitor snippets for reference:
${snippets}

Return ONLY the JSON object, no other text.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.3,
    max_tokens: 2000,
    messages: [{ role: "user", content: analysisPrompt }]
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    // Fallback if JSON parsing fails
    return {};
  }
}

// Recompute signals: keep frozen, recompute content-based
function recomputeSignals(originalSignals, newAiAnalysis, optimizedContent, keyword, frozenData) {
  const newSignals = {};

  // Process all 34 signals
  Object.keys(SIGNAL_METADATA).forEach((key) => {
    if (FROZEN_SIGNALS.includes(key)) {
      // Keep original score for frozen signals
      newSignals[key] = originalSignals[key] || 0;
    } else {
      // Recompute from AI analysis or derive from content
      if (newAiAnalysis[key] !== undefined) {
        newSignals[key] = Math.min(1, Math.max(0, newAiAnalysis[key] / 100));
      } else {
        // Fallback: derive from content analysis
        newSignals[key] = computeSignalFromContent(key, optimizedContent, keyword);
      }
    }
  });

  // Compute new overall score
  const weights = {
    navboost_ctr: 0.08,
    navboost_satisfaction: 0.07,
    navboost_pogostick: 0.05,
    site_authority: 0.10,
    nsr_topical: 0.08,
    pagerank0: 0.08,
    referring_domains: 0.06,
    content_effort: 0.08,
    smith_composite: 0.10,
    information_gain: 0.07,
    entity_salience: 0.06,
    readability_grade: 0.04,
    heading_depth: 0.04,
    content_structure: 0.05,
    eeat_composite: 0.08,
    ai_detection: 0.03,
    citation_count: 0.05,
    expert_quotes: 0.04,
    cwv_composite: 0.05,
    page_performance: 0.03,
    mobile_friendly: 0.03,
    https_security: 0.02,
    schema_markup: 0.03,
    intent_alignment: 0.07,
    snippet_match: 0.04,
    paa_coverage: 0.04,
    content_gap: 0.05,
    content_freshness: 0.03,
    internal_links: 0.03,
    external_links: 0.03,
    image_optimization: 0.02,
    title_match: 0.05,
    panda_risk: 0.04,
    chard_quality: 0.06
  };

  let newScore = 0;
  Object.keys(weights).forEach((key) => {
    newScore += (newSignals[key] || 0) * weights[key];
  });

  return { newSignals, newScore: Math.min(1, newScore) };
}

// Derive signal from content (fallback)
function computeSignalFromContent(signalKey, content, keyword) {
  const score = 0.7; // Default fallback score

  switch (signalKey) {
    case "title_match":
      return content.toLowerCase().includes(keyword.toLowerCase()) ? 0.85 : 0.4;
    case "content_structure":
      return (content.match(/^#+\s/gm) || []).length > 3 ? 0.75 : 0.5;
    case "readability_grade":
      return content.split(".").length > 10 ? 0.7 : 0.5;
    case "internal_links":
      return (content.match(/\[.*?\]\(\/.*?\)/g) || []).length > 2 ? 0.7 : 0.3;
    case "external_links":
      return (content.match(/\[.*?\]\(https?:\/\//g) || []).length > 1 ? 0.7 : 0.3;
    case "image_optimization":
      return (content.match(/!\[.*?\]\(.*?\)/g) || []).length > 2 ? 0.7 : 0.3;
    default:
      return score;
  }
}

// Build change log
function buildChangeLog(originalSignals, newSignals, round) {
  const changeLog = [];

  Object.keys(SIGNAL_METADATA).forEach((key) => {
    const originalScore = originalSignals[key] || 0;
    const newScore = newSignals[key] || 0;
    const delta = newScore - originalScore;

    if (delta > 0.01) {
      // Signal improved
      const metadata = SIGNAL_METADATA[key];
      changeLog.push({
        type: "improved",
        signal: key,
        label: metadata.label,
        warehouseModule: metadata.warehouseModule,
        before: parseFloat((originalScore * 100).toFixed(1)),
        after: parseFloat((newScore * 100).toFixed(1)),
        delta: parseFloat((delta * 100).toFixed(1)),
        estimatedImpact: estimateSignalImpact(key, delta)
      });
    }
  });

  // Sort by impact
  changeLog.sort((a, b) => b.estimatedImpact - a.estimatedImpact);

  return changeLog.slice(0, 10); // Top 10 improvements
}

// Estimate impact of a signal change
function estimateSignalImpact(signalKey, delta) {
  const weights = {
    site_authority: 0.10,
    smith_composite: 0.10,
    eeat_composite: 0.08,
    intent_alignment: 0.07,
    navboost_ctr: 0.08,
    nsr_topical: 0.08,
    pagerank0: 0.08,
    content_effort: 0.08
  };

  return (weights[signalKey] || 0.04) * 100 * delta;
}

// Categorize signal changes
function categorizeSignalChanges(originalSignals, newSignals) {
  const improved = [];
  const unchanged = [];
  const frozen = [];
  const decreased = [];

  Object.keys(SIGNAL_METADATA).forEach((key) => {
    const original = originalSignals[key] || 0;
    const newVal = newSignals[key] || 0;

    if (FROZEN_SIGNALS.includes(key)) {
      frozen.push({
        signal: key,
        label: SIGNAL_METADATA[key].label,
        score: parseFloat((newVal * 100).toFixed(1))
      });
    } else if (newVal > original + 0.01) {
      improved.push({
        signal: key,
        label: SIGNAL_METADATA[key].label,
        before: parseFloat((original * 100).toFixed(1)),
        after: parseFloat((newVal * 100).toFixed(1)),
        delta: parseFloat(((newVal - original) * 100).toFixed(1))
      });
    } else if (newVal < original - 0.01) {
      decreased.push({
        signal: key,
        label: SIGNAL_METADATA[key].label,
        before: parseFloat((original * 100).toFixed(1)),
        after: parseFloat((newVal * 100).toFixed(1)),
        delta: parseFloat(((newVal - original) * 100).toFixed(1))
      });
    } else {
      unchanged.push({
        signal: key,
        label: SIGNAL_METADATA[key].label,
        score: parseFloat((newVal * 100).toFixed(1))
      });
    }
  });

  return { improved, unchanged, frozen, decreased };
}

// Frozen signal explanation
function getFrozenNote(signals) {
  const frozenCount = FROZEN_SIGNALS.length;
  return `${frozenCount} signals are frozen (domain/site-level metrics). These include site authority, PageRank, referring domains, Core Web Vitals, and security signals. They can only be improved through off-page optimization (backlinks, site performance) or domain-level changes.`;
}

// Get next round strategy
function getNextRoundStrategy(nextRound) {
  if (nextRound === 2) {
    return {
      round: 2,
      focus: "DEPTH & AUTHORITY",
      targets: [
        "content_effort",
        "eeat_composite",
        "information_gain",
        "citation_count",
        "expert_quotes",
        "content_gap",
        "entity_salience"
      ],
      description: "Increase content depth, add expert credentials, improve E-E-A-T signals, address competitive gaps"
    };
  } else if (nextRound === 3) {
    return {
      round: 3,
      focus: "INTENT & ENGAGEMENT",
      targets: [
        "intent_alignment",
        "navboost_ctr",
        "ai_detection",
        "content_freshness",
        "readability_grade",
        "external_links"
      ],
      description: "Optimize for search intent, improve readability, boost engagement signals, add fresh insights"
    };
  }
  return null;
}
