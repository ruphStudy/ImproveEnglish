import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { createOrder, getOrderStatus, getPlans } from '../api';

export default function BuyPlan() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
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
  const [processingPayment, setProcessingPayment] = useState(false);
  const [orderId, setOrderId] = useState(null);

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

  const handleChange = (e) => {
    const { name, value } = e.target;
    
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
    if (!formData.phone.trim() || formData.phone.length < 10) {
      setError('Please enter a valid 10-digit phone number');
      return false;
    }
    if (!formData.email.trim() || !formData.email.includes('@')) {
      setError('Please enter a valid email address');
      return false;
    }
    return true;
  };

  const handlePayment = async () => {
    setError('');
    
    if (!validateForm()) {
      return;
    }

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
          contact: formData.phone
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
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-12 px-4 sm:px-6 lg:px-8">
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    WhatsApp Number *
                  </label>
                  <input
                    type="tel"
                    name="phone"
                    value={formData.phone}
                    onChange={handleChange}
                    placeholder="9876543210"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">Enter 10-digit number without +91</p>
                </div>

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
                            <div className="text-right">
                              <p className="text-2xl font-bold text-blue-600">₹{plan.price}</p>
                              <p className="text-xs text-gray-500">
                                ₹{Math.round(plan.price / plan.days)}/day
                              </p>
                            </div>
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

              {/* Payment Button */}
              <button
                onClick={handlePayment}
                disabled={loading || processingPayment || loadingPlans || !selectedPlan}
                className={`w-full py-4 rounded-lg font-semibold text-white text-lg transition-all ${
                  loading || processingPayment || loadingPlans || !selectedPlan
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
            </div>
          </div>
        </div>

        {/* Trust Indicators */}
        <div className="mt-8 text-center text-gray-600">
          <p className="text-sm">
            ⭐ Trusted by 1000+ learners | 💬 24/7 WhatsApp Support | 🏆 Results Guaranteed
          </p>
        </div>
      </div>
    </div>
  );
}
