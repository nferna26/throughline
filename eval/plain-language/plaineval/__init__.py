"""Plain-language eval harness for the Throughline margin tutor (CORE-1169 part 1).

The referee: it measures whether the tutor's explanation of a passage is PLAINER
than the passage itself. The headline gate is a deterministic, offline lexical
difficulty delta (explanation minus source); an optional cross-family LLM judge is
a secondary flag only. See README.md for the gate definition.
"""

__all__ = ["lexicons", "difficulty", "jargon", "tutor_prompt", "gate", "report", "backends"]
