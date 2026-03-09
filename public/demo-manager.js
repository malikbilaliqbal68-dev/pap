// Demo and Auth Management Script
(function () {
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

    // Check before generating paper
    window.checkBeforeGenerate = async function (subject = 'General') {
        if (!authInitialized) {
            await initAuth();
        }
        return true;
    };

    // Show pricing after demo limit
    window.showPricingIfNeeded = async function () {
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

