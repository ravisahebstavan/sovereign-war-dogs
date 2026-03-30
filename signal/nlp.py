"""
sovereign-signal/nlp.py

Two-stage NLP:
  1. spaCy en_core_web_sm — Named Entity Recognition (ORG extraction)
  2. ProsusAI/finbert     — Financial sentiment [-1 negative, 0 neutral, +1 positive]

FinBERT is a BERT model fine-tuned on ~10k financial news sentences.
It runs in <150ms on CPU, <15ms on GPU.
Model is cached to ~/.cache/huggingface after first download.
"""

import spacy
from transformers import pipeline, AutoTokenizer, AutoModelForSequenceClassification
import torch
import logging

log = logging.getLogger("sovereign.nlp")


class NLPPipeline:
    def __init__(self):
        log.info("loading spaCy en_core_web_sm…")
        self._nlp = spacy.load("en_core_web_sm")

        log.info("loading ProsusAI/finbert (downloading on first run ~400MB)…")
        # Use CPU — deterministic, no CUDA required
        device = 0 if torch.cuda.is_available() else -1
        self._sentiment = pipeline(
            "text-classification",
            model="ProsusAI/finbert",
            tokenizer="ProsusAI/finbert",
            device=device,
            top_k=None,          # return all 3 class scores
            truncation=True,
            max_length=512,
        )
        log.info(f"FinBERT loaded on {'GPU' if device == 0 else 'CPU'}")

    def extract_orgs(self, text: str) -> list[str]:
        """Extract organisation names from text using spaCy NER."""
        doc = self._nlp(text[:1000])  # cap length for speed
        return [ent.text for ent in doc.ents if ent.label_ == "ORG"]

    def sentiment(self, text: str) -> float:
        """
        Returns a float in [-1.0, 1.0]:
          +1.0 = fully positive
           0.0 = neutral
          -1.0 = fully negative
        """
        return self.sentiment_full(text)["scalar"]

    def sentiment_full(self, text: str) -> dict:
        """
        Returns all FinBERT class probabilities plus a scalar score.

        Keys:
          scalar      float in [-1, 1]  — P(positive) - P(negative)
          positive    float in [0, 1]   — raw P(positive)
          negative    float in [0, 1]   — raw P(negative)
          neutral     float in [0, 1]   — raw P(neutral)
          confidence  float in [0, 1]   — max class probability (model certainty)
        """
        results = self._sentiment(text[:512])[0]  # list of {label, score}
        scores = {r["label"]: r["score"] for r in results}
        pos = scores.get("positive", 0.0)
        neg = scores.get("negative", 0.0)
        neu = scores.get("neutral",  0.0)
        return {
            "scalar":     pos - neg,
            "positive":   pos,
            "negative":   neg,
            "neutral":    neu,
            "confidence": max(pos, neg, neu),
        }
