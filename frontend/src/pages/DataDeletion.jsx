import React from 'react';
import Footer from '../components/Footer';

const SUPPORT_EMAIL = 'fluencyenglish@codeexpoglobal.com';

export default function DataDeletion() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-6">
          <a href="/buy" className="text-2xl font-bold text-indigo-600">
            Fluency Loop English
          </a>
        </div>
      </header>

      {/* Content */}
      <main className="flex-grow w-full max-w-4xl mx-auto px-4 py-12">
        <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">Data Deletion Instructions</h1>
        <p className="text-gray-600 mb-8">
          How to request deletion of your Fluency Loop English account and personal data.
        </p>

        <div className="space-y-6 text-gray-700">
          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">1. How to Request Deletion</h2>
            <p>To request deletion of your account and personal data, send an email to{' '}
              <a href={`mailto:${SUPPORT_EMAIL}?subject=Data%20Deletion%20Request`} className="text-indigo-600 hover:underline break-all">
                {SUPPORT_EMAIL}
              </a>{' '}
              with the subject line <strong>"Data Deletion Request"</strong> and include:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li>Your full name</li>
              <li>The WhatsApp phone number registered with Fluency Loop English</li>
              <li>The email address you used when registering, if any</li>
              <li>Whether you want your whole account deleted or only specific data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">2. Data You Can Request to Delete</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Account and contact details:</strong> name, email address and WhatsApp phone number</li>
              <li><strong>Registration data:</strong> information you provided when signing up</li>
              <li><strong>Learning data:</strong> lesson history, progress, streaks, assessments and performance records</li>
              <li><strong>Communication data:</strong> messages and voice-evaluation results stored by our service</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">3. How We Verify Requests</h2>
            <p>
              To protect your account, we only act on requests we can match to a registered learner. We may contact you
              through your registered WhatsApp number or email address to confirm the request before deleting any data.
              If we cannot verify the request, we may ask for more information or be unable to complete it.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">4. Data We May Need to Retain</h2>
            <p>
              Some records may need to be kept even after a deletion request, where required by law or for legitimate
              business purposes such as accounting, tax, fraud prevention or resolving disputes. This includes payment and
              transaction records related to your subscription. Payments are processed by Razorpay, which keeps its own
              records under its own privacy policy.
            </p>
            <p className="mt-3">
              Messages already delivered to your WhatsApp app are stored on your device and by WhatsApp, and are not
              controlled by Fluency Loop English. You can delete them from your device at any time.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">5. After Your Request</h2>
            <p>
              Once your request is verified, we will process it and confirm by email or WhatsApp. After your account is
              deleted, you will no longer receive lessons or reminders, and your learning progress cannot be restored.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">6. More Information</h2>
            <p>
              For details on what data we collect and how we use it, please read our{' '}
              <a href="/privacy-policy" className="text-indigo-600 hover:underline">Privacy Policy</a>.
              For any questions, contact us at{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-indigo-600 hover:underline break-all">{SUPPORT_EMAIL}</a>.
            </p>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}
