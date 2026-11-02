// Mocked AI output for manual review of Beginner Days 1, 15 and 30 (no OpenAI cost).
const PREFIX = '🔊 Speak this conversation aloud slowly and clearly.';

module.exports = {
  1: {
    title: 'Introducing Yourself',
    scenarioType: 'Talking about yourself',
    conversation: `${PREFIX}\n\nA: Hello! What is your name?\nB: My name is Priya.\nA: Where do you live?\nB: I live in Pune.\nA: Nice to meet you!\nB: Nice to meet you too!`,
    explanation: 'My name is ___.\nI live in ___.\nUse these to tell people about you.',
    guidedSpeakingPrompts: ['My name is ___.', 'I live in ___.'],
    newVocabulary: [
      { word: 'name', meaning: 'what people call you', example: 'My name is Ravi.' },
      { word: 'live', meaning: 'to have your home somewhere', example: 'I live in Delhi.' },
      { word: 'meet', meaning: 'to see someone and say hello', example: 'Nice to meet you!' }
    ],
    microPractice: { q1: 'My name ___ Priya.', q2: 'I ___ in Pune.' },
    confidenceLine: 'Great job! Keep speaking every day!'
  },
  15: {
    title: 'My Evening at Home',
    scenarioType: 'Talking about your evening',
    conversation: `${PREFIX}\n\nA: What do you do in the evening?\nB: In the evening, I cook dinner.\nA: What do you cook?\nB: I cook rice and dal.\nA: Do you watch TV?\nB: Yes, I watch the news.\nA: That sounds nice!`,
    explanation: 'In the evening, I ___.\nUse it to talk about your evening at home.',
    guidedSpeakingPrompts: ['In the evening, I ___.', 'After dinner, I ___.'],
    newVocabulary: [
      { word: 'evening', meaning: 'the time after the afternoon', example: 'I walk in the evening.' },
      { word: 'cook', meaning: 'to make food', example: 'I cook dinner at home.' },
      { word: 'news', meaning: 'new information about the world', example: 'I watch the news.' }
    ],
    microPractice: { q1: 'In the evening, I ___ dinner.', q2: 'What do you do in the evening?' },
    confidenceLine: 'Well done! You are speaking more every day!'
  },
  30: {
    title: 'Talking About Myself',
    scenarioType: 'Telling someone about you',
    conversation: `${PREFIX}\n\nA: Tell me about yourself.\nB: I'm Anil. I live in Nagpur.\nA: What do you do?\nB: I work at a bank.\nA: What do you like?\nB: I like cricket and music.\nA: Great! Nice talking to you.`,
    explanation: 'I am ___.\nI live in ___.\nI like ___.\nPut these together to talk about yourself.',
    guidedSpeakingPrompts: ['I am ___ and I live in ___.', 'I like ___.'],
    newVocabulary: [
      { word: 'yourself', meaning: 'you (the person I am talking to)', example: 'Tell me about yourself.' },
      { word: 'work', meaning: 'a job you do', example: 'I work at a school.' },
      { word: 'music', meaning: 'songs and sounds you enjoy', example: 'I like music.' }
    ],
    microPractice: { q1: 'I ___ in Nagpur.', q2: 'Tell me one thing you like.' },
    confidenceLine: 'Amazing! One month of English - be proud of yourself!'
  }
};
