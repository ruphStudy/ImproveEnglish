import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { createOrder, getOrderStatus, getPlans, getPaymentConfig, validatePromo, activateFree } from '../api';
import Footer from '../components/Footer';
import { checkPhone } from '../utils/phone';
import {
  isPlanEligible,
  checkoutMode,
  promoResetAction,
  buildFreeActivationPayload,
  friendlyPromoError,
  runExclusive,
  nextLessonDelivery,
  formatLessonDelivery,
  levelLabel,
  welcomeNotice
} from '../utils/freePromo';

// ISO code is sent to the backend, which validates and normalizes the number.
// With a country selected the number (with or without "+") must belong to it;
// "Other" (code '') requires a full "+" international number.
const COUNTRIES = [
  { code: 'IN', name: 'India', dial: '91' },
  { code: 'CA', name: 'Canada', dial: '1' },
  { code: 'US', name: 'United States', dial: '1' },
  { code: 'GB', name: 'United Kingdom', dial: '44' },
  { code: 'AU', name: 'Australia', dial: '61' },
  { code: 'NZ', name: 'New Zealand', dial: '64' },
  { code: 'AE', name: 'United Arab Emirates', dial: '971' },
  { code: 'SA', name: 'Saudi Arabia', dial: '966' },
  { code: 'QA', name: 'Qatar', dial: '974' },
  { code: 'KW', name: 'Kuwait', dial: '965' },
  { code: 'OM', name: 'Oman', dial: '968' },
  { code: 'BH', name: 'Bahrain', dial: '973' },
  { code: 'SG', name: 'Singapore', dial: '65' },
  { code: 'MY', name: 'Malaysia', dial: '60' },
  { code: 'DE', name: 'Germany', dial: '49' },
  { code: 'FR', name: 'France', dial: '33' },
  { code: 'IE', name: 'Ireland', dial: '353' },
  { code: 'NP', name: 'Nepal', dial: '977' },
  { code: 'BD', name: 'Bangladesh', dial: '880' },
  { code: 'LK', name: 'Sri Lanka', dial: '94' },
  { code: '', name: 'Other country', dial: '' }
];

export default function BuyPlan() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    country: 'IN',
    email: '',
    level: 'beginner',
    planDuration: parseInt(searchParams.get('plan')) || 30
  });
  
  const [plans, setPlans] = useState({
    bigenner: [],
    intermidiate: [],
    advance: []
  });
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [processingPayment, setProcessingPayment] = useState(false);
  const [orderId, setOrderId] = useState(null);
  const [testMode, setTestMode] = useState(false);
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState(null); // server quote for the applied code + selected plan
  const [offer, setOffer] = useState(null); // { code, applicableDurations } of the applied free code
  const [promoMessage, setPromoMessage] = useState('');
  const [promoTone, setPromoTone] = useState('info'); // info | success | error
  const promoRequestRef = useRef(0); // ignores responses for an outdated form state
  const [promoChecking, setPromoChecking] = useState(false);
  const [freeActivated, setFreeActivated] = useState(null);
  const submittingRef = useRef(false); // blocks double submission even before re-render

  useEffect(() => {
    getPaymentConfig()
      .then((res) => setTestMode(!!res.data.razorpayTestMode))
      .catch(() => {});
  }, []);

  // Fetch plans from API
  useEffect(() => {
    const fetchPlans = async () => {
      try {
        const response = await getPlans();
        if (response.data.success) {
          setPlans(response.data.plans);
        }
      } catch (err) {
        console.error('Error fetching plans:', err);
        setError('Failed to load plans. Please refresh the page.');
      } finally {
        setLoadingPlans(false);
      }
    };
    fetchPlans();
  }, []);

  // Get current plan info based on selected level and duration
  const getCurrentPlan = () => {
    const levelMap = {
      'beginner': 'bigenner',
      'intermediate': 'intermidiate',
      'advanced': 'advance'
    };
    const dbLevel = levelMap[formData.level];
    return plans[dbLevel]?.find(p => p.days === formData.planDuration);
  };

  // Get all plans for current level
  const getCurrentLevelPlans = () => {
    const levelMap = {
      'beginner': 'bigenner',
      'intermediate': 'intermidiate',
      'advanced': 'advance'
    };
    const dbLevel = levelMap[formData.level];
    return plans[dbLevel] || [];
  };

  // Generate dynamic duration label
  const getDurationLabel = (days) => {
    if (days === 365) return '1 Year';
    if (days === 180) return '6 Months';
    if (days === 90) return '90 Days';
    if (days === 30) return '30 Days';
    return `${days} Days`;
  };

  // Generate dynamic description
  const getDescription = (days) => {
    if (days <= 30) return 'Perfect for getting started';
    if (days <= 90) return 'Build consistency';
    if (days <= 180) return 'Best value for consistent learning';
    return 'Complete English mastery journey';
  };

  // Get badge based on duration
  const getBadge = (days) => {
    if (days === 180) return 'Popular';
    if (days === 365) return 'Best Value';
    return null;
  };

  const selectedPlan = getCurrentPlan();

  // Load Razorpay script
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, []);

  // Poll order status after payment
  useEffect(() => {
    if (!orderId || !processingPayment) return;

    let attempts = 0;
    const maxAttempts = 20; // 20 seconds
    
    const interval = setInterval(async () => {
      attempts++;
      
      try {
        const response = await getOrderStatus(orderId);
        
        if (response.data.userActivated) {
          setProcessingPayment(false);
          // Show success message
          alert(`🎉 Success! Your account has been activated!\n\nYou'll receive your first lesson tomorrow at 7:00 AM.\n\nCheck your WhatsApp for a welcome message!`);
          // Stay on localhost for development
          window.location.href = '/buy?plan=30';
        } else if (attempts >= maxAttempts) {
          setProcessingPayment(false);
          alert('Payment received! Your account will be activated shortly. Check your WhatsApp for confirmation.');
          window.location.href = '/buy?plan=30';
        }
      } catch (err) {
        console.error('Error polling status:', err);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [orderId, processingPayment]);

  const showPromoMessage = (text, tone = 'info') => {
    setPromoMessage(text);
    setPromoTone(tone);
  };

  const clearPromoQuote = (message = '') => {
    promoRequestRef.current++; // drop any in-flight quote
    setPromo(null);
    setOffer(null);
    setPromoChecking(false);
    showPromoMessage(message);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (promoResetAction(name) === 'clear' && (offer || promo)) {
      clearPromoQuote('Your details changed. Please apply the promo code again.');
    }
    if (['phone', 'country'].includes(name)) setPhoneError('');
    
    if (name === 'level') {
      // When level changes, check if current duration is available
      const levelMap = {
        'beginner': 'bigenner',
        'intermediate': 'intermidiate',
        'advanced': 'advance'
      };
      const newLevelPlans = plans[levelMap[value]] || [];
      const hasDuration = newLevelPlans.some(p => p.days === formData.planDuration);
      
      setFormData(prev => ({
        ...prev,
        [name]: value,
        // If current duration not available in new level, select first available
        planDuration: hasDuration ? prev.planDuration : (newLevelPlans[0]?.days || 30)
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        [name]: value
      }));
    }
  };

  const handlePlanChange = (duration) => {
    if (offer && duration !== formData.planDuration) {
      if (isPlanEligible(offer, duration)) {
        requestPromoQuote(offer.code, duration); // server re-checks the new plan
      } else {
        promoRequestRef.current++;
        setPromo(null);
        setPromoChecking(false);
        showPromoMessage(`${offer.code} is not valid for the ${getDurationLabel(duration)} plan. Choose a plan marked ₹0, or continue with regular payment.`, 'error');
      }
    }
    setFormData(prev => ({
      ...prev,
      planDuration: duration
    }));
  };

  const validateForm = () => {
    if (!formData.name.trim()) {
      setError('Please enter your name');
      return false;
    }
    if (!validatePhone()) {
      setError('Please correct your WhatsApp number');
      return false;
    }
    if (!formData.email.trim() || !formData.email.includes('@')) {
      setError('Please enter a valid email address');
      return false;
    }
    return true;
  };

  const selectedCountry = COUNTRIES.find(c => c.code === formData.country) || COUNTRIES[0];

  const validatePhone = () => {
    const { error: msg } = checkPhone(formData.phone, formData.country, selectedCountry.name);
    setPhoneError(msg || '');
    return !msg;
  };

  const getInternationalPhone = () => checkPhone(formData.phone, formData.country, selectedCountry.name).e164;

  // Server quote for `code` on `planDuration` with the current details; the
  // backend computes the price - the page only shows the result.
  const requestPromoQuote = async (code, planDuration) => {
    const requestId = ++promoRequestRef.current;
    setPromo(null);
    setPromoChecking(true);
    showPromoMessage('Checking your code…');
    try {
      const res = await validatePromo({
        code,
        phone: formData.phone,
        country: formData.country,
        level: formData.level,
        planDuration
      });
      if (requestId !== promoRequestRef.current) return;
      if (res.data.valid && res.data.isFree) {
        const applicableDurations = res.data.applicableDurations || null;
        setOffer({ code: res.data.promo.code, applicableDurations });
        setPromo({
          code: res.data.promo.code,
          originalAmount: res.data.promo.originalAmount,
          isFree: true,
          applicableDurations,
          planDuration
        });
        showPromoMessage(`${res.data.promo.code} applied - 100% discount.`, 'success');
      } else if (res.data.valid) {
        setOffer(null);
        showPromoMessage('This code is not a free access code. You can continue with regular payment.', 'error');
      } else {
        // Only a plan-length refusal keeps the applied offer (switching back re-checks
        // it); expired / used-up / any other refusal removes the ₹0 display entirely.
        if (!/not valid for .*plan/i.test(res.data.message || '')) setOffer(null);
        showPromoMessage(friendlyPromoError(res.data.message), 'error');
      }
    } catch (err) {
      if (requestId !== promoRequestRef.current) return;
      showPromoMessage(
        err.response ? friendlyPromoError(err.response.data?.message) : 'Could not check the code. Please check your connection and try again.',
        'error'
      );
    } finally {
      if (requestId === promoRequestRef.current) setPromoChecking(false);
    }
  };

  const handleApplyPromo = async () => {
    const code = promoInput.trim();
    if (!code) {
      showPromoMessage('Please enter a promo code.', 'error');
      return;
    }
    // The backend checks the code against the WhatsApp number, so ask for it first.
    if (!formData.phone.trim() || !validatePhone()) {
      showPromoMessage('Enter a valid WhatsApp number above first - we use it to check the code.', 'error');
      document.getElementById('phone')?.focus();
      return;
    }
    await requestPromoQuote(code, formData.planDuration);
  };

  const handleRemovePromo = () => {
    setPromoInput('');
    clearPromoQuote();
  };

  const handleFreeActivation = async () => {
    setError('');
    if (checkoutMode(promo, formData.planDuration) !== 'free' || !validateForm()) return;
    await runExclusive(submittingRef, async () => {
      setLoading(true);
      try {
        // Only the existing free endpoint - never a Razorpay order. Safe to
        // retry: the backend makes repeated requests for the same number + code idempotent.
        const res = await activateFree(buildFreeActivationPayload(formData, promo));
        // Server values are authoritative (a retry returns the original activation).
        setFreeActivated({
          name: formData.name.trim(),
          phone: getInternationalPhone(),
          level: res.data.level || formData.level,
          planDuration: res.data.planDuration || formData.planDuration,
          expiryDate: res.data.expiryDate,
          welcomeStatus: res.data.welcomeStatus,
          alreadyActivated: !!res.data.alreadyActivated,
          firstLesson: nextLessonDelivery()
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        if (err.response && [400, 409].includes(err.response.status)) {
          clearPromoQuote();
          setError(`${err.response.data?.message || 'This code could not be used.'} You can still continue with regular payment.`);
        } else {
          setError(err.response?.data?.message || 'Could not activate free access. Please try again.');
        }
      } finally {
        setLoading(false);
      }
    });
  };

  const handlePayment = async () => {
    setError('');
    
    // A valid free code never goes through Razorpay.
    if (checkoutMode(promo, formData.planDuration) === 'free') return;
    if (submittingRef.current || !validateForm()) {
      return;
    }

    submittingRef.current = true;
    setLoading(true);

    try {
      // Create order
      const response = await createOrder(formData);
      const { keyId, orderId: razorpayOrderId, amountPaise, currency } = response.data;

      setOrderId(razorpayOrderId);

      // Razorpay checkout options
      const options = {
        key: keyId,
        amount: amountPaise,
        currency: currency,
        name: 'FluencyLoop',
        description: `${selectedPlan.duration} English Learning Plan`,
        order_id: razorpayOrderId,
        prefill: {
          name: formData.name,
          email: formData.email,
          contact: getInternationalPhone()
        },
        theme: {
          color: '#3B82F6'
        },
        handler: function (response) {
          // Payment successful
          console.log('Payment success:', response);
          setProcessingPayment(true);
          // Webhook will activate user, we just wait and poll
        },
        modal: {
          ondismiss: function() {
            setLoading(false);
            setError('Payment cancelled. Please try again.');
          }
        }
      };

      const razorpay = new window.Razorpay(options);
      razorpay.open();
      setLoading(false);

    } catch (err) {
      console.error('Payment error:', err);
      setError(err.response?.data?.message || 'Failed to initiate payment. Please try again.');
      setLoading(false);
    } finally {
      submittingRef.current = false;
    }
  };

  const busy = loading || processingPayment || loadingPlans || !selectedPlan;
  const isFreeCheckout = checkoutMode(promo, formData.planDuration) === 'free';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      <div className="flex-grow py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            Start Your English Learning Journey 🚀
          </h1>
          <p className="text-lg text-gray-600">
            Join thousands learning English via WhatsApp with AI-powered daily lessons
          </p>
        </div>

        {/* Processing Overlay */}
        {processingPayment && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-8 max-w-md text-center">
              <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mx-auto mb-4"></div>
              <h3 className="text-xl font-semibold mb-2">Processing Payment...</h3>
              <p className="text-gray-600">Activating your account. Please wait.</p>
            </div>
          </div>
        )}

        {freeActivated ? (
          <FreeActivationSuccess activation={freeActivated} />
        ) : (
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="md:flex">
            {/* Left Side - Form */}
            <div className="md:w-1/2 p-8">
              <h2 className="text-2xl font-bold mb-6 text-gray-800">Your Details</h2>
              
              {error && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-600 text-sm">{error}</p>
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Full Name *
                  </label>
                  <input
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="Enter your full name"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
                    WhatsApp Number *
                  </label>
                  <div className="flex gap-2">
                    <select
                      name="country"
                      aria-label="Country code"
                      value={formData.country}
                      onChange={handleChange}
                      className="w-32 shrink-0 px-2 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      {COUNTRIES.map((c) => (
                        <option key={c.code || 'other'} value={c.code}>{c.code ? `${c.code} +${c.dial}` : 'Other'}</option>
                      ))}
                    </select>
                    <input
                      id="phone"
                      type="tel"
                      name="phone"
                      inputMode="tel"
                      autoComplete="tel-national"
                      value={formData.phone}
                      onChange={handleChange}
                      placeholder={formData.country === 'IN' ? '9876543210' : (formData.country ? 'Phone number' : '+44 7400 123456')}
                      aria-describedby="phone-help"
                      aria-invalid={phoneError ? 'true' : undefined}
                      className="min-w-0 flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      required
                    />
                  </div>
                  {phoneError && (
                    <p role="alert" className="text-sm text-red-600 mt-1">{phoneError}</p>
                  )}
                  <p id="phone-help" className="text-xs text-gray-500 mt-1">
                    {selectedCountry.code
                      ? `${selectedCountry.name} (+${selectedCountry.dial}). Enter the number without the country code. Country not listed? Choose Other.`
                      : 'Type the full number starting with + and the country code.'}
                  </p>
                </div>

                {/* Promo code (optional) - above plan selection; needs the WhatsApp number */}
                {!freeActivated && (
                  <div className="p-4 border border-dashed border-green-400 bg-green-50/50 rounded-lg">
                    <label htmlFor="promo" className="block text-sm font-medium text-gray-700 mb-1">
                      Have a promo code? <span className="text-gray-500 font-normal">(optional)</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="promo"
                        type="text"
                        value={promoInput}
                        onChange={(e) => { setPromoInput(e.target.value.toUpperCase()); if (offer || promo) clearPromoQuote(); }}
                        placeholder="Enter code"
                        autoComplete="off"
                        readOnly={!!offer}
                        aria-describedby="promo-status"
                        className="min-w-0 flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent uppercase read-only:bg-gray-100"
                      />
                      {offer ? (
                        <button
                          type="button"
                          onClick={handleRemovePromo}
                          disabled={loading}
                          className="px-4 py-2 rounded-lg font-semibold border border-gray-400 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleApplyPromo}
                          disabled={promoChecking || loading}
                          className="px-4 py-2 rounded-lg font-semibold border border-blue-600 text-blue-600 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {promoChecking ? 'Checking…' : 'Apply'}
                        </button>
                      )}
                    </div>
                    <p
                      id="promo-status"
                      role="status"
                      aria-live="polite"
                      className={`text-sm mt-2 ${promoTone === 'success' ? 'text-green-700 font-medium' : promoTone === 'error' ? 'text-red-600' : 'text-gray-600'}`}
                    >
                      {promoMessage}
                    </p>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email Address *
                  </label>
                  <input
                    type="email"
                    name="email"
                    value={formData.email}
                    onChange={handleChange}
                    placeholder="your@email.com"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Current English Level
                  </label>
                  <select
                    name="level"
                    value={formData.level}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="beginner">Beginner - Just starting</option>
                    <option value="intermediate">Intermediate - Can understand basics</option>
                    <option value="advanced">Advanced - Want to improve fluency</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Right Side - Plan Selection */}
            <div className="md:w-1/2 bg-gray-50 p-8">
              <h2 className="text-2xl font-bold mb-6 text-gray-800">Choose Your Plan</h2>
              
              {loadingPlans ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
                  <p className="mt-4 text-gray-600">Loading plans...</p>
                </div>
              ) : (
                <>
                  <div className="space-y-3 mb-6">
                    {getCurrentLevelPlans().map((plan) => {
                      const label = getDurationLabel(plan.days);
                      const description = getDescription(plan.days);
                      const badge = getBadge(plan.days);
                      const freeWithCode = offer && isPlanEligible(offer, plan.days);

                      return (
                        <div
                          key={plan.days}
                          onClick={() => handlePlanChange(plan.days)}
                          className={`relative p-4 border-2 rounded-lg cursor-pointer transition-all ${
                            formData.planDuration === plan.days
                              ? 'border-blue-500 bg-blue-50 shadow-md'
                              : 'border-gray-200 hover:border-blue-300'
                          }`}
                        >
                          {badge && (
                            <span className="absolute -top-2 -right-2 bg-green-500 text-white text-xs px-2 py-1 rounded-full font-semibold">
                              {badge}
                            </span>
                          )}
                          <div className="flex justify-between items-center">
                            <div>
                              <h3 className="font-bold text-lg text-gray-900">{label}</h3>
                              <p className="text-sm text-gray-600">{description}</p>
                            </div>
                            {freeWithCode ? (
                              <div className="text-right">
                                <p className="text-sm text-gray-400 line-through">₹{plan.price}</p>
                                <p className="text-2xl font-bold text-green-600">₹0</p>
                                <p className="text-xs text-green-700">with {offer.code}</p>
                              </div>
                            ) : (
                              <div className="text-right">
                                <p className="text-2xl font-bold text-blue-600">₹{plan.price}</p>
                                <p className="text-xs text-gray-500">
                                  {offer ? 'Code not valid for this plan' : `₹${Math.round(plan.price / plan.days)}/day`}
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Features */}
              <div className="bg-white rounded-lg p-4 mb-6">
                <h3 className="font-semibold text-gray-900 mb-3">What you'll get:</h3>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start">
                    <span className="text-green-500 mr-2">✓</span>
                    <span>Daily AI-powered personalized lessons</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-green-500 mr-2">✓</span>
                    <span>Learn through WhatsApp at your convenience</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-green-500 mr-2">✓</span>
                    <span>5-part structured learning method</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-green-500 mr-2">✓</span>
                    <span>Progress tracking and daily reminders</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-green-500 mr-2">✓</span>
                    <span>No app installation required</span>
                  </li>
                </ul>
              </div>

              {offer && promoChecking ? (
                <button disabled className="w-full py-4 rounded-lg font-semibold text-white text-lg bg-gray-400 cursor-not-allowed">
                  Checking your code…
                </button>
              ) : isFreeCheckout && selectedPlan ? (
                <>
                  <div className="bg-white border border-green-200 rounded-lg p-4 mb-4 text-sm">
                    <p className="font-semibold text-green-700 mb-2">✅ 100% Discount Applied</p>
                    <div className="flex justify-between text-gray-600">
                      <span>{getDurationLabel(formData.planDuration)} plan</span>
                      <span className="line-through">₹{promo.originalAmount}</span>
                    </div>
                    <div className="flex justify-between text-green-700">
                      <span>Promo {promo.code}</span>
                      <span>−₹{promo.originalAmount}</span>
                    </div>
                    <div className="flex justify-between font-bold text-gray-900 text-lg border-t mt-2 pt-2">
                      <span>Total to pay:</span>
                      <span>₹0</span>
                    </div>
                    <p className="text-gray-600 mt-2">No payment or card details required.</p>
                  </div>
                  <button
                    onClick={handleFreeActivation}
                    disabled={busy}
                    className={`w-full py-4 rounded-lg font-semibold text-white text-lg transition-all ${
                      busy ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700 shadow-lg hover:shadow-xl'
                    }`}
                  >
                    {loading ? 'Activating…' : `Activate My Free ${formData.planDuration}-Day Plan`}
                  </button>
                </>
              ) : (
              <>
              {testMode && (
                <div role="note" className="mb-4 p-3 bg-yellow-50 border border-yellow-300 rounded-lg text-sm text-yellow-800 text-center">
                  ⚠️ Razorpay <strong>Test Mode</strong> - no real money will be charged.
                </div>
              )}

              {/* Payment Button */}
              <button
                onClick={handlePayment}
                disabled={busy}
                className={`w-full py-4 rounded-lg font-semibold text-white text-lg transition-all ${
                  busy
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700 shadow-lg hover:shadow-xl'
                }`}
              >
                {loading || loadingPlans ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                    </svg>
                    {loadingPlans ? 'Loading plans...' : 'Processing...'}
                  </span>
                ) : selectedPlan ? (
                  `Pay ₹${selectedPlan.price} & Start Learning`
                ) : (
                  'Select a plan to continue'
                )}
              </button>

              <p className="text-xs text-gray-500 text-center mt-4">
                🔒 Secure payment powered by Razorpay
              </p>
              </>
              )}
            </div>
          </div>
        </div>
        )}

        {/* Trust Indicators */}
        <div className="mt-8 text-center text-gray-600">
          <p className="text-sm">
            ⭐ Trusted by 1000+ learners | 💬 24/7 WhatsApp Support | 🏆 Results Guaranteed
          </p>
        </div>
      </div>
      
      <Footer />
      </div>
    </div>
  );
}

const NOTICE_STYLES = {
  success: 'bg-green-50 border-green-200 text-green-900',
  warning: 'bg-amber-50 border-amber-300 text-amber-900',
  info: 'bg-blue-50 border-blue-200 text-blue-900'
};

// Replaces the form and pricing after a free activation.
function FreeActivationSuccess({ activation }) {
  const firstLesson = formatLessonDelivery(activation.firstLesson);
  const notice = welcomeNotice(activation.welcomeStatus, { phone: activation.phone, firstLesson });
  const expiry = activation.expiryDate
    ? new Date(activation.expiryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const details = [
    ['Name', activation.name],
    ['Level', levelLabel(activation.level)],
    ['Plan', `${activation.planDuration} days`],
    ['Paid', '₹0'],
    ...(expiry ? [['Valid until', expiry]] : []),
    ['First lesson', firstLesson]
  ];
  const steps = [
    ['Get the WhatsApp notification', 'Every morning at 7:00 AM (India time), we send a lesson notification.'],
    ['Reply START', 'Your lesson for the day arrives right away.'],
    ['Do the lesson', 'Read, speak the conversation aloud and practise. Voice notes are welcome.'],
    ['Reply DONE', 'This completes the day. Your next lesson comes the next morning.']
  ];

  return (
    <section role="status" aria-live="polite" className="bg-white rounded-2xl shadow-xl p-6 sm:p-10 max-w-2xl mx-auto">
      <div className="text-center mb-6">
        <div className="text-5xl mb-3" aria-hidden="true">🎉</div>
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">Registration successful!</h2>
        <p className="text-gray-600 mt-2">
          {activation.alreadyActivated
            ? `Welcome back, ${activation.name}. This number is already registered with this code - here are your plan details.`
            : `Welcome to Fluency Loop English, ${activation.name}. Your free plan is active.`}
        </p>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        {details.map(([label, value]) => (
          <div key={label} className="bg-gray-50 rounded-lg px-4 py-3">
            <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
            <dd className="font-semibold text-gray-900 break-words">{value}</dd>
          </div>
        ))}
      </dl>

      <div className={`border rounded-lg p-4 mb-6 ${NOTICE_STYLES[notice.tone]}`}>
        <p className="font-semibold">{notice.title}</p>
        <p className="text-sm mt-1">{notice.text}</p>
      </div>

      <h3 className="font-semibold text-gray-900 mb-3">How your daily lesson works</h3>
      <ol className="space-y-3">
        {steps.map(([title, text], i) => (
          <li key={title} className="flex gap-3">
            <span className="shrink-0 w-7 h-7 rounded-full bg-green-600 text-white text-sm font-bold flex items-center justify-center">{i + 1}</span>
            <span>
              <span className="font-medium text-gray-900">{title}</span>
              <span className="block text-sm text-gray-600">{text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
