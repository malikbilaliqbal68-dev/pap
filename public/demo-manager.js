// Demo and Auth Management Script
(function () {
    const DEMO_LIMIT = 2;
    let currentUser = null;
    let auth = null;

    let authInitialized = false;
    let authPromise = null;

    // Wait for Firebase to load
    function waitForFirebase() {
        if (authPromise) return authPromise;
        authPromise = new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (window.firebase) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
            setTimeout(() => {
                clearInterval(checkInterval);
                resolve();
            }, 5000);
        });
        return authPromise;
    }

    // Initialize Firebase Auth
    async function initAuth() {
        await waitForFirebase();
        try {
            const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');
            auth = getAuth();
            return new Promise((resolve) => {
                auth.onAuthStateChanged((user) => {
                    currentUser = user;
                    authInitialized = true;
                    console.log('Auth state changed:', user ? 'Logged in' : 'Logged out');
                    updateUI();
                    resolve(user);
                });
            });
        } catch (e) {
            console.error('Auth init failed:', e);
            authInitialized = true;
        }
    }

    // Update UI based on auth status
    function updateUI() {
        const loginBtn = document.getElementById('loginBtn');
        const mobileLoginBtn = document.getElementById('mobileLoginBtn');

        if (currentUser) {
            if (loginBtn) {
                loginBtn.className = 'fa-solid fa-right-from-bracket text-xl text-red-500 cursor-pointer hover:text-red-700';
                loginBtn.title = 'Logout';
                loginBtn.onclick = logout;
            }
            if (mobileLoginBtn) {
                mobileLoginBtn.className = 'fa-solid fa-right-from-bracket text-xl text-red-500 cursor-pointer hover:text-red-700';
                mobileLoginBtn.title = 'Logout';
                mobileLoginBtn.onclick = logout;
            }
        } else {
            if (loginBtn) {
                loginBtn.className = 'fa-regular fa-user-circle text-xl text-gray-400 cursor-pointer hover:text-[#19c880]';
                loginBtn.title = 'Login';
                loginBtn.onclick = () => window.toggleModal && window.toggleModal('loginModal');
            }
            if (mobileLoginBtn) {
                mobileLoginBtn.className = 'fa-regular fa-user-circle text-xl text-gray-400 cursor-pointer hover:text-[#19c880]';
                mobileLoginBtn.title = 'Login';
                mobileLoginBtn.onclick = () => window.toggleModal && window.toggleModal('loginModal');
            }
        }
    }

    // Logout function
    async function logout() {
        if (auth && currentUser) {
            await auth.signOut();
            currentUser = null;
            alert('Logged out successfully!');
            window.location.href = '/';
        }
    }

    // Check demo usage
    async function checkDemoUsage(subject = 'General') {
        try {
            const userId = currentUser ? currentUser.uid : getGuestId();
            const storedEmail = (localStorage.getItem('paperify_user_email') || '').trim();
            const response = await fetch(`/api/demo/check?userId=${encodeURIComponent(userId)}&subject=${encodeURIComponent(subject)}&userEmail=${encodeURIComponent(storedEmail)}`);
            return await response.json();
        } catch (error) {
            return { count: 0, limit: DEMO_LIMIT };
        }
    }

    // Track demo usage
    async function trackDemoUsage(subject = 'General') {
        try {
            const userId = currentUser ? currentUser.uid : getGuestId();
            const storedEmail = (localStorage.getItem('paperify_user_email') || '').trim();
            const response = await fetch('/api/demo/track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, subject, userEmail: storedEmail })
            });
            return await response.json();
        } catch (error) {
            return { count: 0, limit: DEMO_LIMIT };
        }
    }

    // Get or create guest ID
    function getGuestId() {
        let guestId = localStorage.getItem('paperify_guest_id');
        if (!guestId) {
            guestId = 'guest_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('paperify_guest_id', guestId);
        }
        return guestId;
    }

    // Check before generating paper
    window.checkBeforeGenerate = async function (subject = 'General') {
        // Ensure auth is initialized before checking usage
        if (!authInitialized) {
            await initAuth();
        }

        const usage = await checkDemoUsage(subject);

        // Handle temporary unlimited (Admin/SuperUser)
        if (usage.unlimited) return true;

        if (!currentUser && usage.count >= usage.limit) {
            // Show payment modal instead of login modal
            if (confirm(`Demo limit reached! You've used ${usage.count}/${usage.limit} free papers. \n\nTo continue generating unlimited papers, please select a plan.`)) {
                window.location.href = '/?showPricing=true';
            }
            return false;
        }

        // Check subscription for logged in users
        if (currentUser) {
            // The backend check/track will return an error if subscription is missing or limit reached
            if (usage.error) {
                const referralHint = usage.referral && usage.referral.referralCode
                    ? `\n\nYour referral code: ${usage.referral.referralCode}\nPaid referrals: ${usage.referral.paidReferrals}/${usage.referral.requiredPaidReferrals}`
                    : '';
                if (confirm(`${usage.error}${referralHint}\n\nClick OK to see available plans.`)) {
                    window.location.href = '/?showPricing=true';
                }
                return false;
            }
        }

        // Track the usage
        const trackResult = await trackDemoUsage(subject);
        if (trackResult.error) {
            const referralHint = trackResult.referral && trackResult.referral.referralCode
                ? `\n\nYour referral code: ${trackResult.referral.referralCode}\nPaid referrals: ${trackResult.referral.paidReferrals}/${trackResult.referral.requiredPaidReferrals}`
                : '';
            if (confirm(`${trackResult.error}${referralHint}\n\nClick OK to see available plans.`)) {
                window.location.href = '/?showPricing=true';
            }
            return false;
        }

        if (!currentUser && trackResult.count >= trackResult.limit) {
            alert(`This is your last free paper! (${trackResult.count}/${trackResult.limit}). Login to get more.`);
        }

        return true;
    };

    // Show pricing after demo limit
    window.showPricingIfNeeded = async function () {
        const usage = await checkDemoUsage();
        if (currentUser && usage.count >= usage.limit) {
            if (window.toggleModal) window.toggleModal('pricingModal');
            return true;
        }
        return false;
    };

    // Initialize on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAuth);
    } else {
        initAuth();
    }

    // Check for showLogin parameter
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('showLogin') === 'true') {
        setTimeout(() => {
            if (window.toggleModal) window.toggleModal('loginModal');
        }, 500);
    }

    window.logout = logout;
})();
