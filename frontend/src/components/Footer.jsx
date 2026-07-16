import React from 'react';

export default function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-300 py-8 mt-auto">
      <div className="max-w-6xl mx-auto px-4">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          {/* Brand */}
          <div className="text-center md:text-left">
            <h3 className="text-xl font-bold text-white mb-1">Fluency Loops</h3>
            <p className="text-sm text-gray-400">by CodeExpo</p>
          </div>

          {/* Links */}
          <div className="flex gap-6 text-sm">
            <a 
              href="/privacy-policy" 
              className="hover:text-white transition-colors"
            >
              Privacy Policy
            </a>
            <a 
              href="/terms" 
              className="hover:text-white transition-colors"
            >
              Terms & Conditions
            </a>
            <a 
              href="/contact" 
              className="hover:text-white transition-colors"
            >
              Contact Us
            </a>
          </div>

          {/* Copyright */}
          <div className="text-sm text-gray-400">
            © 2024 CodeExpo. All rights reserved.
          </div>
        </div>
      </div>
    </footer>
  );
}
