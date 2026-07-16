import React from 'react';
import Footer from '../components/Footer';

export default function Contact() {
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
        <h1 className="text-4xl font-bold text-gray-900 mb-4">Contact Us</h1>
        <p className="text-gray-600 mb-8">
          We'd love to hear from you! Whether you have questions, feedback, or need support, feel free to reach out.
        </p>

        <div className="grid md:grid-cols-2 gap-8">
          {/* Contact Information Card */}
          <div className="bg-white rounded-lg shadow-md p-8">
            <h2 className="text-2xl font-semibold text-gray-900 mb-6">Get in Touch</h2>
            
            <div className="space-y-6">
              {/* Business Name */}
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-indigo-600" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
                    <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path>
                  </svg>
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">Business Name</p>
                  <p className="mt-1 text-lg text-gray-900 font-semibold">CodeExpo</p>
                </div>
              </div>

              {/* Product */}
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-indigo-600" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
                    <path d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"></path>
                  </svg>
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">Product</p>
                  <p className="mt-1 text-lg text-gray-900 font-semibold">Fluency Loops</p>
                  <p className="text-sm text-gray-600 mt-1">AI-Powered English Learning via WhatsApp</p>
                </div>
              </div>

              {/* Email */}
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <svg className="h-6 w-6 text-indigo-600" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
                    <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path>
                  </svg>
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-500">Email</p>
                  <a 
                    href="mailto:hello@fluencyloops.in" 
                    className="mt-1 text-lg text-indigo-600 hover:text-indigo-700 font-semibold hover:underline"
                  >
                    hello@fluencyloops.in
                  </a>
                </div>
              </div>
            </div>

            {/* CTA Button */}
            <div className="mt-8 pt-6 border-t border-gray-200">
              <a
                href="mailto:hello@fluencyloops.in"
                className="w-full inline-flex justify-center items-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
              >
                Send us an Email
                <svg className="ml-2 -mr-1 w-5 h-5" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
                  <path d="M14 5l7 7m0 0l-7 7m7-7H3"></path>
                </svg>
              </a>
            </div>
          </div>

          {/* Information Card */}
          <div className="space-y-6">
            {/* Support Hours */}
            <div className="bg-indigo-50 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                <svg className="h-5 w-5 text-indigo-600 mr-2" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
                  <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                Support Hours
              </h3>
              <p className="text-gray-700">
                We typically respond within 24-48 hours during business days.
              </p>
            </div>

            {/* FAQ */}
            <div className="bg-white rounded-lg shadow-md p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Quick Help</h3>
              <div className="space-y-3 text-sm">
                <div>
                  <p className="font-medium text-gray-900">Having issues with lessons?</p>
                  <p className="text-gray-600">Check your WhatsApp connection and subscription status.</p>
                </div>
                <div>
                  <p className="font-medium text-gray-900">Payment questions?</p>
                  <p className="text-gray-600">Include your transaction ID or registered phone number in your email.</p>
                </div>
                <div>
                  <p className="font-medium text-gray-900">Want to provide feedback?</p>
                  <p className="text-gray-600">We'd love to hear your suggestions for improving Fluency Loops!</p>
                </div>
              </div>
            </div>

            {/* Social Links Placeholder */}
            <div className="bg-gray-100 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Connect With Us</h3>
              <p className="text-gray-600 text-sm">
                Stay tuned! We'll be launching our social media channels soon to share English learning tips, 
                success stories, and platform updates.
              </p>
            </div>
          </div>
        </div>

        {/* Additional Info Section */}
        <div className="mt-12 bg-white rounded-lg shadow-md p-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-4">About Fluency Loops</h2>
          <p className="text-gray-700 leading-relaxed">
            Fluency Loops by CodeExpo is an innovative English learning platform that brings personalized AI-powered 
            lessons directly to your WhatsApp. Our mission is to make quality English education accessible, convenient, 
            and engaging for learners across India. With daily lessons, voice pronunciation feedback, and progress tracking, 
            we help you build consistent learning habits and achieve fluency through practice loops.
          </p>
        </div>
      </main>

      <Footer />
    </div>
  );
}
