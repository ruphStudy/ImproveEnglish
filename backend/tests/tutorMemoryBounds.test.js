const TutorMemory = require('../models/TutorMemory');
const { capBoundedArrays, BOUNDS } = TutorMemory;

describe('TutorMemory.capBoundedArrays', () => {
  test('caps vocabBank at 50 entries (previously unbounded)', () => {
    const doc = { vocabBank: Array.from({ length: 80 }, (_, i) => ({ word: `w${i}` })) };
    capBoundedArrays(doc);
    expect(doc.vocabBank.length).toBe(BOUNDS.vocabBank);
    expect(doc.vocabBank[doc.vocabBank.length - 1].word).toBe('w79'); // keeps the most recent
  });

  test('caps recentTopicDays and recentGrammarKeys at 7', () => {
    const doc = {
      recentTopicDays: Array.from({ length: 15 }, (_, i) => i + 1),
      recentGrammarKeys: Array.from({ length: 15 }, (_, i) => `grammar-${i}`)
    };
    capBoundedArrays(doc);
    expect(doc.recentTopicDays.length).toBe(7);
    expect(doc.recentGrammarKeys.length).toBe(7);
  });

  test('caps recentScenarioTypes at 5', () => {
    const doc = { recentScenarioTypes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] };
    capBoundedArrays(doc);
    expect(doc.recentScenarioTypes).toEqual(['c', 'd', 'e', 'f', 'g']);
  });

  test('leaves arrays already within bounds untouched', () => {
    const doc = { weakAreas: ['pronunciation'], recentScenarioTypes: ['dining'] };
    capBoundedArrays(doc);
    expect(doc.recentScenarioTypes).toEqual(['dining']);
  });
});
