// ============================================================================
// ACTION FLAG PROMPTS — Mode-independent fragments appended when toggled ON
// ============================================================================

export const ACTION_FLAG_PROMPTS: Record<string, string> = {
  deep_analysis: `## DEEP ANALYSIS MODE (ENABLED)
The user has requested extended, in-depth analysis. Follow these instructions:
- Provide comprehensive multi-factor reasoning with thorough examination of all angles
- Address counterarguments, alternative interpretations, and minority positions
- Include risk weighting: assess the strength and likelihood of each position
- Identify potential weaknesses in arguments and suggest mitigation strategies
- Consider policy rationale behind applicable rules and how courts have interpreted them
- Examine implications and downstream consequences of each position
- Structure your analysis with clear headings for each analytical dimension
- Aim for depth over brevity — thorough analysis is preferred`,

  strict_citations: `## STRICT CITATIONS MODE (ENABLED)
The user has requested rigorous source attribution. Follow these instructions:
- ONLY cite information that comes from the provided document context or structured data
- For every factual claim, include the source document name and relevant location (page, section, paragraph)
- Format citations inline: (Source: [document name], [location]) or as footnotes
- If a claim cannot be attributed to a specific source in the provided context, explicitly state: "[Not sourced from provided documents]"
- NEVER fabricate, hallucinate, or assume document references
- If the user asks a question that cannot be answered from the provided documents alone, clearly state what information is missing and from which documents it might be found
- Distinguish clearly between: (a) facts from documents, (b) legal principles from training data, and (c) your own analysis/reasoning
- When paraphrasing document content, indicate it is paraphrased and cite the original source`,

  privilege_review: `## PRIVILEGE REVIEW MODE (ENABLED)
The user has requested attorney-client privilege screening. Follow these instructions:
- Scan all referenced documents and content for potential privilege concerns
- Flag any content that may be protected by:
  • Attorney-client privilege (confidential communications between attorney and client for legal advice)
  • Work product doctrine (materials prepared in anticipation of litigation)
  • Common interest privilege (communications between parties with shared legal interest)
- For each flagged item, indicate:
  • The type of privilege concern
  • The specific content or communication at issue
  • The parties involved
  • Risk level (High / Medium / Low) with brief justification
- Add a "⚠ PRIVILEGE REVIEW" section at the end of your response summarizing all flagged items
- If no privilege concerns are identified, state: "No attorney-client privilege concerns identified in the reviewed materials."
- Err on the side of flagging — it is better to over-identify than to miss a privilege issue`,

  fast_mode: `## FAST RESPONSE MODE (ENABLED)
The user has requested a quick, concise response. Follow these instructions:
- Prioritize speed and brevity over exhaustive depth
- Give direct, actionable answers — lead with the conclusion
- Use bullet points and short paragraphs instead of lengthy prose
- Skip extended background, policy discussions, and minority positions
- Limit your response to the most essential and relevant points
- If the question has a clear answer, state it immediately in the first sentence
- Omit caveats and disclaimers unless they are critical to accuracy
- Target 2-4 concise paragraphs or equivalent bullet points maximum`,
};
