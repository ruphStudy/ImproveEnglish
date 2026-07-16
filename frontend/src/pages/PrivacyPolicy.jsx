import React from 'react';
import Footer from '../components/Footer';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <a href="/buy" className="text-2xl font-bold text-indigo-600">
            Fluency Loops
          </a>
        </div>
      </header>

      {/* Content */}
      <main className="flex-grow max-w-4xl mx-auto px-4 py-12">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">Privacy Policy</h1>
        <p className="text-gray-600 mb-8">Last Updated: June 16, 2026</p>

        <div className="prose prose-lg max-w-none space-y-6 text-gray-700">
          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">1. Introduction</h2>
            <p>
              Welcome to Fluency Loops, operated by CodeExpo. We are committed to protecting your personal information 
              and your right to privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard 
              your information when you use our English learning service via WhatsApp.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">2. Information We Collect</h2>
            <h3 className="text-xl font-semibold text-gray-800 mb-2">2.1 Personal Information</h3>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Contact Information:</strong> Name, email address, WhatsApp phone number</li>
              <li><strong>Registration Data:</strong> Information provided during sign-up via Google Forms</li>
              <li><strong>Payment Information:</strong> Billing details processed securely through Razorpay (we do not store complete payment card information)</li>
            </ul>

            <h3 className="text-xl font-semibold text-gray-800 mb-2 mt-4">2.2 Usage Information</h3>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Learning Activity:</strong> Lesson completion status, streak data, performance metrics</li>
              <li><strong>Communication Data:</strong> Messages exchanged via WhatsApp, including voice recordings for pronunciation evaluation</li>
              <li><strong>Device Information:</strong> WhatsApp user agent, message timestamps, interaction logs</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">3. How We Use Your Information</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Service Delivery:</strong> To send daily English lessons via WhatsApp</li>
              <li><strong>AI Processing:</strong> To generate personalized lessons using OpenAI's GPT-4</li>
              <li><strong>Voice Evaluation:</strong> To transcribe and evaluate your pronunciation using OpenAI's Whisper API</li>
              <li><strong>Progress Tracking:</strong> To maintain your learning streak and performance analytics</li>
              <li><strong>Payment Processing:</strong> To process subscriptions and payments via Razorpay</li>
              <li><strong>Communication:</strong> To send reminders, weekly summaries, and important service updates</li>
              <li><strong>Service Improvement:</strong> To analyze usage patterns and enhance learning experiences</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">4. Third-Party Services</h2>
            <p>We use the following third-party services that may collect and process your data:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>WhatsApp Cloud API (Meta):</strong> For message delivery and communication</li>
              <li><strong>OpenAI:</strong> For AI-powered lesson generation and voice transcription/evaluation</li>
              <li><strong>Razorpay:</strong> For secure payment processing</li>
              <li><strong>Google Forms:</strong> For user registration</li>
              <li><strong>MongoDB Atlas:</strong> For secure data storage</li>
            </ul>
            <p className="mt-3">
              Each of these services has its own privacy policy governing how they handle your data.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">5. Data Security</h2>
            <p>
              We implement appropriate technical and organizational security measures to protect your personal information, 
              including encryption, secure API authentication, rate limiting, and access controls. However, no method of 
              transmission over the internet is 100% secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">6. Data Retention</h2>
            <p>
              We retain your personal information for as long as necessary to provide our services and comply with legal 
              obligations. Voice recordings are processed in real-time and temporarily stored for evaluation purposes, 
              then deleted. Learning progress data is retained to maintain your history and analytics.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">7. Your Rights</h2>
            <p>You have the right to:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Access your personal data</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of your data</li>
              <li>Opt-out of non-essential communications</li>
              <li>Withdraw consent for data processing</li>
            </ul>
            <p className="mt-3">
              To exercise these rights, please contact us at <a href="mailto:hello@fluencyloops.in" className="text-indigo-600 hover:underline">hello@fluencyloops.in</a>
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">8. Children's Privacy</h2>
            <p>
              Our service is intended for users aged 13 and above. We do not knowingly collect personal information 
              from children under 13. If you believe we have collected such information, please contact us immediately.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">9. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you of significant changes via 
              WhatsApp or email. Your continued use of our service after changes constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">10. Contact Us</h2>
            <p>
              If you have questions about this Privacy Policy or our data practices, please contact us:
            </p>
            <div className="bg-gray-100 p-4 rounded-lg mt-3">
              <p><strong>Business Name:</strong> CodeExpo</p>
              <p><strong>Product:</strong> Fluency Loops</p>
              <p><strong>Email:</strong> <a href="mailto:hello@fluencyloops.in" className="text-indigo-600 hover:underline">hello@fluencyloops.in</a></p>
            </div>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
