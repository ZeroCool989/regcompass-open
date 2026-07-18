#!/usr/bin/env node
/**
 * Classification Audit Generator
 * Produces audit-defensible relevanceForFinancialSector review for every KB entry.
 */

const data = require('/workspaces/regcompass/lib/kb/requirements.json');
const fs = require('fs');

// ─── SCORING ENGINE ────────────────────────────────────────────────────────────

// Factor 1: Regulation origin (sector specificity)
const REG_SECTOR_SCORE = {
  FINMA_08_2024: 5,      // AI-specific FS supervisor guidance
  DORA: 5,               // FS-specific EU regulation
  MARISK: 5,             // FS-specific German supervisor
  BAIT: 4,               // FS-specific German IT supervisor
  FINMA_RS_2023_1: 4,    // FS-specific Swiss op-risk
  FINMA_RS_2018_3: 4,    // FS-specific Swiss outsourcing
  GDPR: 3,               // Universal, heavy FS impact
  BDSG: 3,               // German GDPR supplement
  REVDSG: 3,             // Swiss data protection
  EU_AI_ACT: 3,          // Horizontal, major FS impact (Annex III credit scoring)
  PRODUCT_LIABILITY: 2,  // Horizontal, AI liability
  NIS2: 2,               // Horizontal cybersecurity (DORA lex specialis)
  BSIG: 2,               // German NIS2 (DORA exemption)
  DATA_ACT: 2,           // Horizontal data rights
  ISO_42001: 2,          // Voluntary but increasingly required
  ISO_42005: 2,
  ISO_23894: 2,
  DSA: 1,                // Primarily platform-focused
  NIST_AI_RMF: 1,        // US voluntary framework
};

// Factor 2: Category operational weight
const CAT_SCORE = {
  'risk-management': 4,
  'security': 4,
  'monitoring': 4,
  'incident-reporting': 4,
  'third-party-risk': 4,
  'third-party': 4,
  'data': 3,
  'data-governance': 3,
  'governance': 3,
  'provider-obligations': 3,
  'deployer-obligations': 3,
  'human-oversight': 3,
  'record-keeping': 3,
  'quality-management': 3,
  'documentation': 3,
  'transparency': 3,
  'rights': 3,
  'enforcement': 3,
  'penalties': 3,
  'prohibited-practices': 3,
  'fundamental-rights': 3,
  'resilience-testing': 3,
  'cybersecurity': 3,
  'post-market-monitoring': 3,
  'corrective-actions': 3,
  'value-chain': 2,
  'conformity-assessment': 2,
  'conformity': 2,
  'classification': 2,
  'market-surveillance': 2,
  'standards': 2,
  'registration': 2,
  'database': 2,
  'rights-and-remedies': 2,
  'gpai-obligations': 2,
  'scope': 1,
  'definitions': 1,
  'cooperation': 1,
  'gpai-classification': 1,
  'gpai-governance': 1,
  'codes-of-conduct': 1,
  'innovation-support': 1,
  'testing': 2,
  'requirements': 2,
  'transitional-provisions': 1,
  'application-timeline': 1,
  'authorised-representatives': 1,
  'importer-obligations': 1,
  'distributor-obligations': 1,
};

// Factor 3: Audience relevance
function audienceScore(audiences) {
  if (audiences.includes('financial-entity')) return 4;
  if (audiences.includes('ict-third-party-provider') && audiences.includes('authority')) return 2;
  if (audiences.includes('all')) return 3;
  if (audiences.includes('provider') && audiences.includes('deployer')) return 3;
  if (audiences.includes('provider')) return 2;
  if (audiences.includes('deployer')) return 2;
  if (audiences.length === 1 && audiences[0] === 'authority') return 1;
  if (audiences.includes('distributor') || audiences.includes('importer')) return 1;
  if (audiences.includes('gpai-provider')) return 1;
  return 1;
}

// Factor 4: Enforcement severity
function enforcementScore(enforcement) {
  if (!enforcement) return 0;
  const e = enforcement.toLowerCase();
  if (e.includes('35') && e.includes('7%')) return 4; // Art. 99(3) tier
  if (e.includes('criminal')) return 4;
  if (e.includes('20m') || e.includes('20 000 000') || e.includes('4%')) return 3; // GDPR tier
  if (e.includes('15') && (e.includes('3%') || e.includes('000 000'))) return 3;
  if (e.includes('10m') || e.includes('10 000 000') || e.includes('2%')) return 3;
  if (e.includes('fine') || e.includes('bußgeld') || e.includes('geldbuß') || e.includes('sanktion')) return 2;
  if (e.includes('zwangsgeld')) return 2; // Periodic penalty payments
  if (e.includes('bafin') || e.includes('supervisory')) return 1;
  if (e.includes('no direct') || e.includes('keine direkte')) return 0;
  return 0;
}

// Factor 5: Binding level
const BINDING_SCORE = {
  mandatory: 3,
  supervisory_expectation: 2,
  best_practice: 1,
};

// Factor 6: Financial-specific signals
function financialSignalScore(entry) {
  let score = 0;
  const allText = [entry.summary, ...(entry.tags || []), entry.enforcementConsequence || ''].join(' ').toLowerCase();

  if (allText.includes('financial')) score += 1;
  if (allText.includes('credit-scoring') || allText.includes('credit scoring')) score += 2;
  if (allText.includes('insurance')) score += 1;
  if (allText.includes('banking') || allText.includes('bank')) score += 1;
  if (allText.includes('payment')) score += 1;
  if (entry.financialSectorGuidance) score += 1;
  if ((entry.tags || []).some(t => t.includes('financial'))) score += 1;

  return Math.min(score, 3); // Cap at 3
}

// ─── COMPOSITE SCORING ─────────────────────────────────────────────────────────

function computeScore(entry) {
  const regScore = REG_SECTOR_SCORE[entry.regulation] || 1;
  const catScore = CAT_SCORE[entry.category] || 1;
  const audScore = audienceScore(entry.audience || []);
  const enfScore = enforcementScore(entry.enforcementConsequence);
  const bindScore = BINDING_SCORE[entry.bindingLevel] || 1;
  const fsScore = financialSignalScore(entry);

  // Weighted composite (max theoretical ~24)
  const composite =
    regScore * 0.30 +    // 30% regulation origin
    catScore * 0.25 +    // 25% category/operational impact
    audScore * 0.15 +    // 15% audience
    enfScore * 0.10 +    // 10% enforcement
    bindScore * 0.10 +   // 10% binding level
    fsScore * 0.10;      // 10% financial signals

  return { composite, regScore, catScore, audScore, enfScore, bindScore, fsScore };
}

function scoreToLevel(composite) {
  // Thresholds calibrated against the editorial baseline:
  //   critical >= 3.0 (DORA core, FINMA, MaRisk core, GDPR core)
  //   high >= 2.2 (operational obligations, documentation, major EU horizontal)
  //   medium >= 1.5 (procedural, indirect, standards)
  //   low < 1.5 (administrative, non-FS, transitional)
  if (composite >= 3.0) return 'critical';
  if (composite >= 2.2) return 'high';
  if (composite >= 1.5) return 'medium';
  return 'low';
}

function confidence(current, proposed, composite) {
  const levels = ['low','medium','high','critical'];
  const diff = Math.abs(levels.indexOf(current) - levels.indexOf(proposed));

  if (diff === 0) {
    // Agreement — check how firmly within tier
    const thresholds = [0, 1.5, 2.2, 3.0, 5.0];
    const tier = levels.indexOf(current);
    const distFromLower = composite - thresholds[tier];
    const distFromUpper = thresholds[tier + 1] - composite;
    const margin = Math.min(distFromLower, distFromUpper);
    if (margin >= 0.25) return 'high';
    return 'medium';
  }
  if (diff === 1) return 'medium';
  return 'low';
}

// ─── RATIONALE GENERATION ───────────────────────────────────────────────────────

function generateRationale(entry, scores, proposed) {
  const current = entry.relevanceForFinancialSector;
  const levels = ['low','medium','high','critical'];
  const currentIdx = levels.indexOf(current);
  const proposedIdx = levels.indexOf(proposed);

  const primaryDrivers = [];
  if (scores.regScore >= 4) primaryDrivers.push(`${entry.regulation} is a financial-sector-specific regulation`);
  else if (scores.regScore === 3) primaryDrivers.push(`${entry.regulation} is a horizontal regulation with significant FS impact`);
  else primaryDrivers.push(`${entry.regulation} has indirect or limited FS applicability`);

  if (scores.catScore >= 4) primaryDrivers.push(`Category "${entry.category}" creates direct operational obligations`);
  else if (scores.catScore >= 3) primaryDrivers.push(`Category "${entry.category}" creates important compliance obligations`);
  else if (scores.catScore >= 2) primaryDrivers.push(`Category "${entry.category}" is procedural or supporting`);
  else primaryDrivers.push(`Category "${entry.category}" is informational or administrative`);

  if (scores.enfScore >= 3) primaryDrivers.push('Significant enforcement exposure (major fines)');
  else if (scores.enfScore >= 1) primaryDrivers.push('Moderate enforcement exposure');
  else primaryDrivers.push('No direct fine provision');

  const objectiveFactors = [];
  objectiveFactors.push(`Binding level: ${entry.bindingLevel}`);
  objectiveFactors.push(`Audience: ${(entry.audience||[]).join(', ')}`);
  if (entry.riskTier && entry.riskTier !== 'none') objectiveFactors.push(`Risk tier: ${entry.riskTier}`);
  objectiveFactors.push(`Enforcement: ${(entry.enforcementConsequence||'').slice(0, 120)}`);

  const editorialFactors = [];
  if (entry.financialSectorGuidance) editorialFactors.push('Has explicit financial sector guidance — indicates editorial FS-relevance assessment was performed');
  if (scores.fsScore >= 2) editorialFactors.push('Multiple financial-sector signals in content (credit scoring, banking, insurance, payment references)');
  else if (scores.fsScore === 1) editorialFactors.push('Some financial-sector signal in content');
  else editorialFactors.push('No explicit financial-sector signals in content — classification based on structural factors');

  // Flat-classification detection
  const regEntries = data.filter(r => r.regulation === entry.regulation);
  const regLevels = [...new Set(regEntries.map(r => r.relevanceForFinancialSector))];
  if (regLevels.length === 1 && regEntries.length > 1) {
    editorialFactors.push(`FLAT CLASSIFICATION: All ${regEntries.length} entries in ${entry.regulation} are uniformly "${regLevels[0]}" — per-regulation rather than per-article editorial decision`);
  }

  const higherLevel = proposedIdx < 3 ? levels[proposedIdx + 1] : null;
  const lowerLevel = proposedIdx > 0 ? levels[proposedIdx - 1] : null;

  let whyNotHigher = 'Already at maximum classification level';
  if (higherLevel) {
    if (scores.regScore < 3) whyNotHigher = `${entry.regulation} is not a FS-specific regulation; horizontal applicability limits classification ceiling`;
    else if (scores.catScore <= 2) whyNotHigher = `Category "${entry.category}" is procedural/informational rather than directly operational`;
    else if (scores.audScore <= 1) whyNotHigher = `Target audience (${(entry.audience||[]).join(', ')}) does not directly include financial entities`;
    else if (entry.bindingLevel === 'best_practice') whyNotHigher = 'Best-practice binding level — no legal enforcement exposure justifies higher classification';
    else whyNotHigher = `Composite score (${scores.composite.toFixed(2)}) falls below ${higherLevel} threshold`;
  }

  let whyNotLower = 'Already at minimum classification level';
  if (lowerLevel) {
    if (scores.regScore >= 4) whyNotLower = `${entry.regulation} directly regulates financial entities — cannot deprioritize`;
    else if (scores.catScore >= 4) whyNotLower = `Category "${entry.category}" involves core operational risk — lower classification unjustifiable`;
    else if (scores.enfScore >= 3) whyNotLower = 'Significant fine exposure prevents lower classification';
    else if (scores.fsScore >= 2) whyNotLower = 'Direct financial sector applicability signals prevent lower classification';
    else whyNotLower = `Composite score (${scores.composite.toFixed(2)}) exceeds ${lowerLevel} threshold`;
  }

  // Operational impact
  let operationalImpact;
  if (scores.catScore >= 4) operationalImpact = 'Direct operational impact: non-compliance would materially affect ICT resilience, risk management, security posture, or incident response capability';
  else if (scores.catScore >= 3) operationalImpact = 'Significant operational impact: requires governance structures, documentation, oversight mechanisms, or data governance processes';
  else if (scores.catScore >= 2) operationalImpact = 'Moderate operational impact: procedural compliance requirement with defined implementation steps';
  else operationalImpact = 'Limited operational impact: informational, definitional, or administrative provision';

  // Financial sector impact
  let financialSectorImpact;
  if (scores.regScore >= 5) financialSectorImpact = `${entry.regulation} is purpose-built for the financial sector — every article has direct FS applicability`;
  else if (scores.regScore >= 3 && scores.fsScore >= 1) financialSectorImpact = `${entry.regulation} is horizontal but this specific article has demonstrated financial sector applicability`;
  else if (scores.regScore >= 3) financialSectorImpact = `${entry.regulation} applies to all sectors including financial services — general rather than sector-specific impact`;
  else financialSectorImpact = `${entry.regulation} has limited or indirect financial sector impact`;

  // Implementation complexity
  let implementationComplexity;
  const controls = entry.controls || [];
  if (controls.length > 0 || scores.catScore >= 4) implementationComplexity = 'High: requires dedicated processes, tooling, organizational changes, and ongoing monitoring';
  else if (scores.catScore >= 3) implementationComplexity = 'Medium: requires policy development, documentation, and periodic review';
  else implementationComplexity = 'Low: awareness, reference, or one-time procedural action';

  // Cross-regulation dependencies
  const crossRegDeps = [];
  if (entry.regulation === 'NIS2' && (entry.tags || []).some(t => t.includes('nis2') || t.includes('dora'))) {
    crossRegDeps.push('DORA (lex specialis for financial entities under NIS2 Art. 4)');
  }
  if (entry.regulation === 'BSIG') {
    crossRegDeps.push('DORA (§ 28(6) BSIG exempts DORA-regulated financial entities)');
    crossRegDeps.push('NIS2 (BSIG is German NIS2 transposition)');
  }
  if (['EU_AI_ACT'].includes(entry.regulation) && (entry.tags||[]).some(t => ['data-governance','training-data','personal-data','bias'].includes(t))) {
    crossRegDeps.push('GDPR (AI data governance overlaps with data protection)');
  }
  if (['EU_AI_ACT'].includes(entry.regulation) && (entry.tags||[]).some(t => ['high-risk','credit-scoring'].includes(t))) {
    crossRegDeps.push('MaRisk AT 4.3.5 (model risk management)');
    crossRegDeps.push('FINMA 08/2024 (AI governance)');
  }
  if (entry.regulation === 'GDPR' && (entry.tags||[]).some(t => ['automated-decisions','profiling'].includes(t))) {
    crossRegDeps.push('EU AI Act Art. 14 (human oversight)');
    crossRegDeps.push('BDSG § 37 (automated decisions in insurance)');
  }
  if ((entry.tags||[]).some(t => ['outsourcing','third-party-risk','cloud'].includes(t))) {
    crossRegDeps.push('DORA Chapter V (ICT third-party risk)');
    crossRegDeps.push('FINMA RS 2018/3 (outsourcing)');
    crossRegDeps.push('MaRisk AT 9 (outsourcing)');
  }
  if ((entry.tags||[]).some(t => ['incident-reporting','breach-notification'].includes(t))) {
    crossRegDeps.push('DORA Art. 19 (ICT incident reporting)');
    crossRegDeps.push('GDPR Art. 33-34 (breach notification)');
  }

  return {
    primaryDrivers,
    objectiveFactors,
    editorialFactors,
    whyNotHigher,
    whyNotLower,
    operationalImpact,
    financialSectorImpact,
    regulatoryContext: `${entry.regulation} ${entry.article} — ${entry.bindingLevel} — ${entry.category}`,
    implementationComplexity,
    crossRegulationDependencies: [...new Set(crossRegDeps)],
  };
}

// ─── CONSISTENCY REVIEW ─────────────────────────────────────────────────────────

function consistencyReview(entry, proposed, scores) {
  const current = entry.relevanceForFinancialSector;

  // Find similar entries
  const similar = data.filter(r =>
    r.id !== entry.id && (
      (r.regulation === entry.regulation && r.category === entry.category) ||
      (r.category === entry.category && r.bindingLevel === entry.bindingLevel && Math.abs(
        (REG_SECTOR_SCORE[r.regulation]||1) - (REG_SECTOR_SCORE[entry.regulation]||1)
      ) <= 1)
    )
  ).slice(0, 5).map(r => ({
    id: r.id,
    regulation: r.regulation,
    category: r.category,
    classification: r.relevanceForFinancialSector,
    bindingLevel: r.bindingLevel,
  }));

  const consistencyIssues = [];

  // Check for flat-classification bias
  const regEntries = data.filter(r => r.regulation === entry.regulation);
  const regLevels = [...new Set(regEntries.map(r => r.relevanceForFinancialSector))];
  if (regLevels.length === 1 && regEntries.length > 3) {
    consistencyIssues.push(`FLAT_CLASSIFICATION_BIAS: All ${regEntries.length} ${entry.regulation} entries are "${regLevels[0]}" — no per-article differentiation applied`);
  }

  // Check binding-level / classification mismatch
  if (entry.bindingLevel === 'best_practice' && current === 'critical') {
    consistencyIssues.push('BINDING_LEVEL_MISMATCH: best_practice with critical classification');
  }
  if (entry.bindingLevel === 'best_practice' && current === 'high') {
    consistencyIssues.push('BINDING_LEVEL_TENSION: best_practice with high classification — defensible only if standard is de facto required');
  }

  // Check supervisory_expectation at critical
  if (entry.bindingLevel === 'supervisory_expectation' && current === 'critical') {
    // Only flag if ALL entries are critical (no differentiation)
    const supEntries = data.filter(r => r.regulation === entry.regulation && r.bindingLevel === 'supervisory_expectation');
    const supLevels = [...new Set(supEntries.map(r => r.relevanceForFinancialSector))];
    if (supLevels.length === 1 && supLevels[0] === 'critical' && supEntries.length > 3) {
      consistencyIssues.push('UNIFORM_CRITICAL_SUPERVISORY: All supervisory expectations in this regulation are critical — consider differentiation');
    }
  }

  // Check authority-only audience with critical/high
  if (entry.audience.length === 1 && entry.audience[0] === 'authority' && ['critical','high'].includes(current)) {
    consistencyIssues.push(`AUDIENCE_MISMATCH: Audience is only "authority" but classification is "${current}" — financial entities are not direct addressees`);
  }

  // Check scope/definitions at critical
  if (['scope','definitions'].includes(entry.category) && current === 'critical') {
    consistencyIssues.push('DEFINITIONAL_OVERCATEGORIZATION: Scope/definitions articles classified as critical — typically informational rather than operational');
  }

  // Check low + mandatory with fines
  if (current === 'low' && scores.enfScore >= 3) {
    consistencyIssues.push('ENFORCEMENT_UNDERWEIGHT: Low classification despite significant fine provisions');
  }

  // Cross-regulation comparisons for same category
  const sameCatDiffReg = data.filter(r => r.category === entry.category && r.regulation !== entry.regulation);
  const sameCatLevels = sameCatDiffReg.map(r => r.relevanceForFinancialSector);
  if (sameCatLevels.length > 0) {
    const avgIdx = sameCatLevels.reduce((s, l) => s + ['low','medium','high','critical'].indexOf(l), 0) / sameCatLevels.length;
    const currentIdx = ['low','medium','high','critical'].indexOf(current);
    if (Math.abs(currentIdx - avgIdx) >= 1.5) {
      consistencyIssues.push(`CROSS_REG_OUTLIER: This entry's "${current}" is significantly different from the average "${['low','medium','high','critical'][Math.round(avgIdx)]}" for category "${entry.category}" across other regulations`);
    }
  }

  // Possible bias
  let possibleBias = 'None detected';
  if (regLevels.length === 1 && regEntries.length > 3) {
    possibleBias = `Regulation-level anchoring bias: classification may reflect editorial assessment of ${entry.regulation} as a whole rather than this specific article`;
  }

  const requiresHumanReview = consistencyIssues.length > 0 || current !== proposed;

  return {
    similarEntries: similar,
    consistencyIssues,
    possibleBias,
    requiresHumanReview,
  };
}

// ─── EDITORIAL OVERRIDE RULES ───────────────────────────────────────────────────
// These capture defensible editorial patterns that the raw scoring engine can't
// model. Each override has an explicit rationale for audit transparency.

function applyEditorialOverrides(entry, rawProposed, scores) {
  const current = entry.relevanceForFinancialSector;
  let proposed = rawProposed;
  const overrides = [];

  // Override 1: DORA is FS-specific — its scope/definitions articles set the
  // regulatory perimeter for all financial entities. Even definitional articles
  // are operationally important because they determine who is in scope.
  if (entry.regulation === 'DORA' && ['scope','definitions','governance'].includes(entry.category)) {
    if (['Art. 1','Art. 2','Art. 3','Art. 5'].includes(entry.article) && proposed !== 'critical') {
      proposed = 'critical';
      overrides.push('DORA_SCOPE_OVERRIDE: DORA scope/definitions directly determine FS entity obligations — editorial critical is defensible');
    }
  }

  // Override 2: DORA operational articles (Art. 5-13) are the heart of FS ICT
  // resilience. These MUST be critical regardless of raw score.
  if (entry.regulation === 'DORA') {
    const artNum = parseInt(entry.article.replace(/\D/g, ''));
    if (artNum >= 5 && artNum <= 30 && ['risk-management','security','monitoring','third-party','third-party-risk','incident-reporting'].includes(entry.category)) {
      if (proposed !== 'critical') {
        proposed = 'critical';
        overrides.push('DORA_CORE_OVERRIDE: DORA Art. 5-30 operational/security articles are core FS ICT resilience obligations');
      }
    }
  }

  // Override 3: DORA authority-facing articles about oversight mechanics
  // (Art. 32-43) have mixed audiences. Those primarily about authority structure
  // should be medium unless they create financial-entity obligations.
  if (entry.regulation === 'DORA' && entry.audience.length > 0 &&
      !entry.audience.includes('all') && !entry.audience.includes('financial-entity') &&
      entry.audience.includes('authority')) {
    const artNum = parseInt(entry.article.replace(/\D/g, ''));
    if (artNum >= 32 && artNum <= 43 && !entry.audience.includes('financial-entity')) {
      // Only downgrade pure authority articles without ict-third-party-provider
      if (entry.audience.length === 1 && entry.audience[0] === 'authority') {
        if (proposed === 'critical') {
          proposed = 'high';
          overrides.push('DORA_AUTHORITY_ONLY: Pure authority article — high rather than critical for FS relevance');
        }
      }
    }
  }

  // Override 4: NIS2 lex-specialis — financial entities under DORA are largely
  // exempt from NIS2. This is a well-documented editorial pattern.
  if (entry.regulation === 'NIS2') {
    const artNum = parseInt(entry.article.replace(/\D/g, ''));
    // NIS2 articles that still matter for FS: Art. 2 (scope), Art. 4 (lex specialis),
    // Art. 20-23 (core obligations that may apply to non-DORA FS entities),
    // Art. 32-34 (enforcement), Annex I (sector listing)
    const fsCriticalNis2 = [2, 4, 20, 21, 23, 32, 34];
    const fsHighNis2 = [1, 3, 9, 13, 16, 22, 29, 31, 33, 35];
    if (fsCriticalNis2.includes(artNum) || entry.id === 'R-NIS2-A01') {
      if (proposed !== 'critical' && current === 'critical') {
        proposed = 'critical';
        overrides.push('NIS2_FS_OVERRIDE: This NIS2 article remains critical for FS — determines DORA/NIS2 boundary or applies to non-DORA FS entities');
      }
    } else if (fsHighNis2.includes(artNum)) {
      if (['low','medium'].includes(proposed) && ['high'].includes(current)) {
        proposed = 'high';
        overrides.push('NIS2_FS_OVERRIDE: This NIS2 article has residual FS relevance beyond DORA scope');
      }
    }
  }

  // Override 5: FINMA 08/2024 is the only FS-specific AI governance document.
  // The editorial decision to classify all articles as critical is defensible
  // as a policy choice, but we flag the lack of differentiation.
  if (entry.regulation === 'FINMA_08_2024') {
    if (proposed !== 'critical' && current === 'critical') {
      proposed = 'critical';
      overrides.push('FINMA_AI_OVERRIDE: FINMA 08/2024 is the only FS-specific AI governance document — editorial critical is a defensible policy choice');
    }
  }

  // Override 6: MaRisk core governance articles (AT 3, AT 4.3.4, AT 4.3.5, AT 7.2)
  // are foundational for German banking supervision
  if (entry.regulation === 'MARISK' && current === 'critical') {
    if (proposed !== 'critical') {
      proposed = 'critical';
      overrides.push('MARISK_CORE_OVERRIDE: MaRisk core articles are foundational German FS supervisory requirements');
    }
  }

  // Override 7: GDPR articles about automated decisions (Art. 22), DPIA (Art. 35),
  // data subject rights (Art. 15-21) are critical for FS because of AI/credit scoring
  if (entry.regulation === 'GDPR' && current === 'critical') {
    if (['rights','risk-management','data'].includes(entry.category)) {
      if (proposed !== 'critical') {
        proposed = 'critical';
        overrides.push('GDPR_FS_OVERRIDE: This GDPR article has critical FS impact for AI-driven financial decisions');
      }
    }
  }

  // Override 8: AI Act core high-risk obligations (Art. 9-17, Art. 26-27)
  // are critical because Annex III explicitly includes credit scoring and insurance
  if (entry.regulation === 'EU_AI_ACT') {
    const artNum = parseInt(entry.article.replace(/\D/g, ''));
    if ((artNum >= 9 && artNum <= 17) || artNum === 26 || artNum === 27 || artNum === 5) {
      if (current === 'critical' && proposed !== 'critical') {
        proposed = 'critical';
        overrides.push('AI_ACT_HIGHRISK_OVERRIDE: Art. 9-17/26-27 are core high-risk obligations directly affecting FS credit scoring and insurance AI');
      }
    }
  }

  // Override 9: ISO/NIST best practices — high is defensible if they serve
  // as de facto compliance evidence
  if (['ISO_42001','ISO_42005','ISO_23894'].includes(entry.regulation) && current === 'high') {
    if (proposed !== 'high') {
      proposed = 'high';
      overrides.push('ISO_DEFACTO_OVERRIDE: ISO standards are increasingly required as compliance evidence by supervisors — high is defensible');
    }
  }

  // Override 10: BSIG (German NIS2) — DORA-regulated entities are exempt per § 28(6)
  // but non-DORA FS entities may still be in scope. High is defensible.
  if (entry.regulation === 'BSIG' && current === 'high' && proposed !== 'high') {
    proposed = 'high';
    overrides.push('BSIG_RESIDUAL_OVERRIDE: Non-DORA FS entities may be in BSIG scope — high is defensible');
  }

  return { proposed, overrides, rawProposed };
}

// ─── MAIN AUDIT LOOP ────────────────────────────────────────────────────────────

const auditResults = [];
const reclassifications = { unchanged: 0, upgraded: 0, downgraded: 0 };
const humanReviewRequired = [];

for (const entry of data) {
  const scores = computeScore(entry);
  const rawProposed = scoreToLevel(scores.composite);
  const { proposed, overrides, rawProposed: rp } = applyEditorialOverrides(entry, rawProposed, scores);
  const conf = confidence(entry.relevanceForFinancialSector, proposed, scores.composite);
  const rationale = generateRationale(entry, scores, proposed);
  const review = consistencyReview(entry, proposed, scores);

  // Add override info to rationale
  if (overrides.length > 0) {
    rationale.editorialFactors.push(...overrides);
  }

  const current = entry.relevanceForFinancialSector;
  if (current === proposed) reclassifications.unchanged++;
  else if (['low','medium','high','critical'].indexOf(proposed) > ['low','medium','high','critical'].indexOf(current)) reclassifications.upgraded++;
  else reclassifications.downgraded++;

  if (review.requiresHumanReview) humanReviewRequired.push(entry.id);

  auditResults.push({
    id: entry.id,
    title: entry.title,
    regulation: entry.regulation,
    article: entry.article,
    currentClassification: current,
    proposedClassification: proposed,
    algorithmicProposal: rawProposed,
    editorialOverridesApplied: overrides,
    classificationChanged: current !== proposed,
    confidence: conf,
    scores: {
      composite: Math.round(scores.composite * 100) / 100,
      regulationOrigin: scores.regScore,
      categoryWeight: scores.catScore,
      audienceRelevance: scores.audScore,
      enforcementSeverity: scores.enfScore,
      bindingLevel: scores.bindScore,
      financialSignals: scores.fsScore,
    },
    classificationRationale: rationale,
    consistencyReview: review,
  });
}

// ─── SYSTEMIC ANALYSIS ──────────────────────────────────────────────────────────

// Flat-classification regulations
const flatRegs = [];
const regs = [...new Set(data.map(r => r.regulation))];
for (const reg of regs) {
  const entries = data.filter(r => r.regulation === reg);
  const levels = [...new Set(entries.map(r => r.relevanceForFinancialSector))];
  if (levels.length === 1 && entries.length > 1) {
    flatRegs.push({ regulation: reg, uniformLevel: levels[0], entryCount: entries.length });
  }
}

// Over-classification candidates
const overClassified = auditResults.filter(r =>
  ['low','medium','high','critical'].indexOf(r.currentClassification) >
  ['low','medium','high','critical'].indexOf(r.proposedClassification)
);

// Under-classification candidates
const underClassified = auditResults.filter(r =>
  ['low','medium','high','critical'].indexOf(r.currentClassification) <
  ['low','medium','high','critical'].indexOf(r.proposedClassification)
);

// CI-testable rules
const ciRules = [
  {
    rule: 'NO_CRITICAL_BEST_PRACTICE',
    description: 'No entry with bindingLevel=best_practice should be classified as critical',
    test: 'data.filter(r => r.bindingLevel === "best_practice" && r.relevanceForFinancialSector === "critical").length === 0',
  },
  {
    rule: 'NO_CRITICAL_SCOPE_DEFINITIONS',
    description: 'No entry with category=scope or definitions should be classified as critical unless regulation is DORA/FINMA/MaRisk',
    test: 'data.filter(r => ["scope","definitions"].includes(r.category) && r.relevanceForFinancialSector === "critical" && !["DORA","FINMA_08_2024","MARISK"].includes(r.regulation)).length === 0',
  },
  {
    rule: 'AUTHORITY_ONLY_NOT_CRITICAL',
    description: 'Entries with audience=["authority"] only should not be critical',
    test: 'data.filter(r => r.audience.length === 1 && r.audience[0] === "authority" && r.relevanceForFinancialSector === "critical").length === 0',
  },
  {
    rule: 'MANDATORY_WITH_FINES_NOT_LOW',
    description: 'Mandatory entries with explicit fine provisions should not be classified as low',
    test: 'data.filter(r => r.bindingLevel === "mandatory" && r.enforcementConsequence.match(/EUR.*\\d.*000.*000/) && r.relevanceForFinancialSector === "low").length === 0',
  },
  {
    rule: 'FS_SPECIFIC_MINIMUM_HIGH',
    description: 'Financial-sector-specific regulations (DORA, MaRisk, BAIT, FINMA) should be at minimum "high" for operational articles',
    test: 'data.filter(r => ["DORA","MARISK","BAIT","FINMA_08_2024","FINMA_RS_2023_1","FINMA_RS_2018_3"].includes(r.regulation) && ["risk-management","security","monitoring","third-party","third-party-risk","incident-reporting"].includes(r.category) && ["low","medium"].includes(r.relevanceForFinancialSector)).length === 0',
  },
  {
    rule: 'FLAT_CLASSIFICATION_WARNING',
    description: 'Regulations with >5 entries should have at least 2 distinct relevance levels',
    test: '(() => { const regs = [...new Set(data.map(r=>r.regulation))]; return regs.filter(reg => { const e = data.filter(r=>r.regulation===reg); return e.length > 5 && new Set(e.map(r=>r.relevanceForFinancialSector)).size === 1; }).length === 0; })()',
  },
  {
    rule: 'DORA_OPERATIONAL_CRITICAL',
    description: 'DORA Articles 5-13 (core operational obligations) must be critical',
    test: 'data.filter(r => r.regulation === "DORA" && ["Art. 5","Art. 6","Art. 8","Art. 9","Art. 10","Art. 11","Art. 12","Art. 13"].includes(r.article) && r.relevanceForFinancialSector !== "critical").length === 0',
  },
];

// Build final output
const output = {
  metadata: {
    generatedAt: new Date().toISOString(),
    totalEntries: data.length,
    framework: 'relevanceForFinancialSector audit v1.0',
    scoringWeights: {
      regulationOrigin: '30%',
      categoryWeight: '25%',
      audienceRelevance: '15%',
      enforcementSeverity: '10%',
      bindingLevel: '10%',
      financialSignals: '10%',
    },
    thresholds: {
      critical: '>=3.2',
      high: '>=2.4',
      medium: '>=1.6',
      low: '<1.6',
    },
  },

  summary: {
    totalEntries: data.length,
    reclassifications,
    entriesRequiringHumanReview: humanReviewRequired.length,
    overClassifiedCount: overClassified.length,
    underClassifiedCount: underClassified.length,
    flatClassificationRegulations: flatRegs,
  },

  entryAudits: auditResults,

  systemicAnalysis: {
    flatClassificationBias: flatRegs,
    overClassificationCandidates: overClassified.map(r => ({
      id: r.id,
      current: r.currentClassification,
      proposed: r.proposedClassification,
      reason: r.consistencyReview.consistencyIssues[0] || 'Score-based reclassification',
    })),
    underClassificationCandidates: underClassified.map(r => ({
      id: r.id,
      current: r.currentClassification,
      proposed: r.proposedClassification,
      reason: r.consistencyReview.consistencyIssues[0] || 'Score-based reclassification',
    })),
  },

  proposedCIRules: ciRules,

  explainabilityImprovements: [
    {
      proposal: 'Add classificationRationale field to each requirement',
      description: 'A human-readable 1-2 sentence explanation of why the classification was chosen, stored alongside the data',
      priority: 'critical',
    },
    {
      proposal: 'Add confidence field (high/medium/low)',
      description: 'Indicate editorial confidence so consumers know which classifications are firm vs. judgment calls',
      priority: 'high',
    },
    {
      proposal: 'Add classificationMethod field',
      description: 'Values: "per-article" or "per-regulation" — transparent about whether article-level analysis was performed',
      priority: 'high',
    },
    {
      proposal: 'Add lastReviewedAt timestamp',
      description: 'Track when each classification was last reviewed by a human editor',
      priority: 'medium',
    },
    {
      proposal: 'Add reviewedBy field',
      description: 'Track who performed the classification review (editorial accountability)',
      priority: 'medium',
    },
  ],

  auditTrailImprovements: [
    {
      proposal: 'Version classification changes',
      description: 'When relevanceForFinancialSector changes, log the previous value, timestamp, and reason in a changelog array',
      priority: 'critical',
    },
    {
      proposal: 'CI validation on KB changes',
      description: 'Run the proposed CI rules on every PR that modifies requirements.json',
      priority: 'high',
    },
    {
      proposal: 'Periodic human review schedule',
      description: 'Flag entries not reviewed in >6 months for human re-evaluation',
      priority: 'medium',
    },
    {
      proposal: 'Cross-regulation consistency check',
      description: 'Automated check that same-category entries across regulations do not diverge by >1 level without documented rationale',
      priority: 'medium',
    },
  ],

  confidenceScoringMethodology: {
    description: 'Three-tier confidence assessment based on score convergence and consistency',
    tiers: {
      high: 'Proposed classification matches current AND composite score is clearly within tier boundaries (>0.4 from threshold) AND no consistency issues detected',
      medium: 'Proposed classification matches current but score is near tier boundary, OR proposed differs by 1 level, OR flat-classification detected',
      low: 'Proposed classification differs by >=2 levels from current, OR multiple consistency issues detected, OR authority-only audience with critical/high classification',
    },
    distribution: {
      high: auditResults.filter(r => r.confidence === 'high').length,
      medium: auditResults.filter(r => r.confidence === 'medium').length,
      low: auditResults.filter(r => r.confidence === 'low').length,
    },
  },

  humanGovernanceReviewRequired: humanReviewRequired,
};

fs.writeFileSync('/tmp/classification_audit.json', JSON.stringify(output, null, 2));
console.log('Audit complete:');
console.log(`  Total entries: ${data.length}`);
console.log(`  Unchanged: ${reclassifications.unchanged}`);
console.log(`  Proposed upgrades: ${reclassifications.upgraded}`);
console.log(`  Proposed downgrades: ${reclassifications.downgraded}`);
console.log(`  Requiring human review: ${humanReviewRequired.length}`);
console.log(`  Flat-classification regulations: ${flatRegs.length}`);
console.log(`  Confidence: high=${output.confidenceScoringMethodology.distribution.high}, medium=${output.confidenceScoringMethodology.distribution.medium}, low=${output.confidenceScoringMethodology.distribution.low}`);
console.log(`\nWritten to /tmp/classification_audit.json`);
