const mongoose = require('mongoose');
require('dotenv').config();

const CurriculumTopic = require('../models/CurriculumTopic');

// Sample curriculum data for testing (Days 1-10 for each level)
const sampleCurriculum = [
  // BEGINNER - Days 1-10
  {
    level: 'beginner',
    day: 1,
    month: 1,
    theme: 'Introduction & Greetings',
    title: 'Basic Greetings and Self-Introduction',
    grammarFocus: 'Present Simple (I am, You are)',
    difficultyTag: 'easy',
    isActive: true
  },
  {
    level: 'beginner',
    day: 2,
    month: 1,
    theme: 'Daily Routines',
    title: 'Talking About Your Day',
    grammarFocus: 'Present Simple (daily activities)',
    difficultyTag: 'easy',
    isActive: true
  },
  {
    level: 'beginner',
    day: 3,
    month: 1,
    theme: 'Food & Drinks',
    title: 'Ordering Food at a Restaurant',
    grammarFocus: 'Would like / Can I have',
    difficultyTag: 'easy',
    isActive: true
  },
  {
    level: 'beginner',
    day: 4,
    month: 1,
    theme: 'Shopping',
    title: 'Asking for Prices and Quantities',
    grammarFocus: 'How much / How many',
    difficultyTag: 'easy',
    isActive: true
  },
  {
    level: 'beginner',
    day: 5,
    month: 1,
    theme: 'Directions',
    title: 'Asking for and Giving Directions',
    grammarFocus: 'Imperative (Turn left, Go straight)',
    difficultyTag: 'easy',
    isActive: true
  },
  {
    level: 'beginner',
    day: 6,
    month: 1,
    theme: 'Family',
    title: 'Describing Your Family',
    grammarFocus: 'Possessive pronouns (my, your, his, her)',
    difficultyTag: 'easy',
    isActive: true
  },
  {
    level: 'beginner',
    day: 7,
    month: 1,
    theme: 'Weather',
    title: 'Talking About the Weather',
    grammarFocus: 'Present Continuous (It is raining)',
    difficultyTag: 'easy',
    isActive: true
  },
  {
    level: 'beginner',
    day: 8,
    month: 1,
    theme: 'Hobbies',
    title: 'Discussing Your Hobbies',
    grammarFocus: 'Like + verb-ing',
    difficultyTag: 'easy',
    isActive: true
  },
  {
    level: 'beginner',
    day: 9,
    month: 1,
    theme: 'Time',
    title: 'Telling and Asking About Time',
    grammarFocus: 'What time is it? / At + time',
    difficultyTag: 'easy',
    isActive: true
  },
  {
    level: 'beginner',
    day: 10,
    month: 1,
    theme: 'Travel',
    title: 'Booking a Taxi or Ride',
    grammarFocus: 'Can you / Could you (polite requests)',
    difficultyTag: 'easy',
    isActive: true
  },

  // INTERMEDIATE - Days 1-10
  {
    level: 'intermediate',
    day: 1,
    month: 1,
    theme: 'Work & Career',
    title: 'Job Interview Basics',
    grammarFocus: 'Present Perfect (I have worked)',
    difficultyTag: 'medium',
    isActive: true
  },
  {
    level: 'intermediate',
    day: 2,
    month: 1,
    theme: 'Technology',
    title: 'Discussing Technology and Gadgets',
    grammarFocus: 'Comparatives and Superlatives',
    difficultyTag: 'medium',
    isActive: true
  },
  {
    level: 'intermediate',
    day: 3,
    month: 1,
    theme: 'Health',
    title: 'Explaining Symptoms to a Doctor',
    grammarFocus: 'Present Perfect vs Past Simple',
    difficultyTag: 'medium',
    isActive: true
  },
  {
    level: 'intermediate',
    day: 4,
    month: 1,
    theme: 'Social Events',
    title: 'Making Plans and Invitations',
    grammarFocus: 'Future forms (going to, will)',
    difficultyTag: 'medium',
    isActive: true
  },
  {
    level: 'intermediate',
    day: 5,
    month: 1,
    theme: 'Education',
    title: 'Discussing Learning Experiences',
    grammarFocus: 'Used to / Would (past habits)',
    difficultyTag: 'medium',
    isActive: true
  },
  {
    level: 'intermediate',
    day: 6,
    month: 1,
    theme: 'Entertainment',
    title: 'Recommending Movies and Shows',
    grammarFocus: 'Should / Must / Have to',
    difficultyTag: 'medium',
    isActive: true
  },
  {
    level: 'intermediate',
    day: 7,
    month: 1,
    theme: 'Money & Finance',
    title: 'Banking and Money Management',
    grammarFocus: 'Conditionals (First Conditional)',
    difficultyTag: 'medium',
    isActive: true
  },
  {
    level: 'intermediate',
    day: 8,
    month: 1,
    theme: 'Relationships',
    title: 'Describing Relationships and Feelings',
    grammarFocus: 'Adjectives and Adverbs',
    difficultyTag: 'medium',
    isActive: true
  },
  {
    level: 'intermediate',
    day: 9,
    month: 1,
    theme: 'Environment',
    title: 'Discussing Environmental Issues',
    grammarFocus: 'Passive Voice',
    difficultyTag: 'medium',
    isActive: true
  },
  {
    level: 'intermediate',
    day: 10,
    month: 1,
    theme: 'Travel',
    title: 'Planning International Travel',
    grammarFocus: 'Future Perfect and Continuous',
    difficultyTag: 'medium',
    isActive: true
  },

  // ADVANCED - Days 1-10
  {
    level: 'advanced',
    day: 1,
    month: 1,
    theme: 'Business Negotiations',
    title: 'Negotiating Contracts and Deals',
    grammarFocus: 'Conditionals (Second and Third)',
    difficultyTag: 'hard',
    isActive: true
  },
  {
    level: 'advanced',
    day: 2,
    month: 1,
    theme: 'Professional Communication',
    title: 'Writing Formal Business Emails',
    grammarFocus: 'Passive Voice (Advanced)',
    difficultyTag: 'hard',
    isActive: true
  },
  {
    level: 'advanced',
    day: 3,
    month: 1,
    theme: 'Presentations',
    title: 'Delivering Professional Presentations',
    grammarFocus: 'Reported Speech',
    difficultyTag: 'hard',
    isActive: true
  },
  {
    level: 'advanced',
    day: 4,
    month: 1,
    theme: 'Debates',
    title: 'Expressing and Defending Opinions',
    grammarFocus: 'Advanced Linking Words',
    difficultyTag: 'hard',
    isActive: true
  },
  {
    level: 'advanced',
    day: 5,
    month: 1,
    theme: 'News & Media',
    title: 'Discussing Current Events',
    grammarFocus: 'Complex Sentence Structures',
    difficultyTag: 'hard',
    isActive: true
  },
  {
    level: 'advanced',
    day: 6,
    month: 1,
    theme: 'Culture',
    title: 'Comparing Cultural Differences',
    grammarFocus: 'Inversion for Emphasis',
    difficultyTag: 'hard',
    isActive: true
  },
  {
    level: 'advanced',
    day: 7,
    month: 1,
    theme: 'Philosophy',
    title: 'Discussing Abstract Concepts',
    grammarFocus: 'Subjunctive Mood',
    difficultyTag: 'hard',
    isActive: true
  },
  {
    level: 'advanced',
    day: 8,
    month: 1,
    theme: 'Law & Ethics',
    title: 'Discussing Legal and Ethical Issues',
    grammarFocus: 'Advanced Modals',
    difficultyTag: 'hard',
    isActive: true
  },
  {
    level: 'advanced',
    day: 9,
    month: 1,
    theme: 'Literature',
    title: 'Analyzing Literary Works',
    grammarFocus: 'Participle Clauses',
    difficultyTag: 'hard',
    isActive: true
  },
  {
    level: 'advanced',
    day: 10,
    month: 1,
    theme: 'Science & Innovation',
    title: 'Discussing Scientific Developments',
    grammarFocus: 'Cleft Sentences',
    difficultyTag: 'hard',
    isActive: true
  }
];

async function seedCurriculum() {
  try {
    console.log('🌱 Starting curriculum seed...');
    
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    // Clear existing curriculum (optional - comment out to keep existing data)
    // await CurriculumTopic.deleteMany({});
    // console.log('🗑️  Existing curriculum cleared');

    // Insert sample curriculum
    const result = await CurriculumTopic.insertMany(sampleCurriculum);
    console.log(`✅ ${result.length} curriculum topics inserted successfully!`);

    console.log('\n📊 Curriculum Summary:');
    console.log(`   - Beginner: ${sampleCurriculum.filter(c => c.level === 'beginner').length} topics`);
    console.log(`   - Intermediate: ${sampleCurriculum.filter(c => c.level === 'intermediate').length} topics`);
    console.log(`   - Advanced: ${sampleCurriculum.filter(c => c.level === 'advanced').length} topics`);

    mongoose.connection.close();
    console.log('\n✅ Seed completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Seed error:', error);
    mongoose.connection.close();
    process.exit(1);
  }
}

// Run the seed
seedCurriculum();
