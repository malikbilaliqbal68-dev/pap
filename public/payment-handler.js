<script>
async function createPaymentOrder(plan, books, applyDiscount = false) {
    try {
        const userEmail = (localStorage.getItem('paperify_user_email') || '').trim();
        const response = await fetch('/api/payment/create-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan, books, applyDiscount, userEmail })
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            showNotification(data.error || 'Unable to create payment link', 'error');
            return null;
        }
        // Don't open new window - keep in modal
        return data;
    } catch (error) {
        showNotification('Error: ' + error.message, 'error');
        return null;
    }
}

function showPaymentForm(plan, amount, books) {
    const planName = plan === 'weekly_unlimited' ? 'Weekly Unlimited (14 Days)' : 
                     plan === 'monthly_specific' ? 'Monthly Specific (30 Papers)' : 
                     'Monthly Unlimited (30 Days)';
    const bookInfo = books && books.length > 0 ? 
        `<p class="text-xs text-gray-600 mt-3"><strong>Books:</strong> ${books.join(', ')}</p>` : '';

    const paymentHTML = `
<div class="text-center mb-6">
    <h3 class="text-2xl font-bold text-[#3f3a64]">Complete Payment</h3>
    <p class="text-sm text-gray-500 mt-1">Submit payment proof for verification</p>
</div>

<div class="space-y-4">
    <div class="bg-gradient-to-br from-[#3f3a64] to-[#19c880] rounded-2xl p-5 text-white">
        <div class="flex justify-between items-start mb-3">
            <div>
                <p class="text-xs opacity-75 uppercase tracking-wider">Plan</p>
                <p class="text-lg font-bold">${planName}</p>
            </div>
            <div class="text-right">
                <p class="text-xs opacity-75 uppercase tracking-wider">Amount</p>
                <p class="text-2xl font-black">PKR ${amount}</p>
            </div>
        </div>
        ${bookInfo ? `<div class="border-t border-white/20 pt-3"><p class="text-xs opacity-90">${bookInfo}</p></div>` : ''}
    </div>

    <div class="bg-blue-50 border-l-4 border-blue-400 p-4 rounded">
        <p class="text-sm text-blue-800 font-semibold mb-1">
            <i class="fas fa-mobile-alt mr-2"></i>Payment Number: ${window.PAYMENT_NUMBER || '03XXXXXXXXX'}
        </p>
        <p class="text-xs text-blue-700">Send PKR ${amount} via JazzCash/EasyPaisa</p>
    </div>

    <div>
        <label class="block text-sm font-bold text-gray-700 mb-2">Transaction ID *</label>
        <input type="text" id="transactionIdInput" placeholder="Enter transaction ID" 
            class="w-full px-4 py-3 border-2 border-gray-200 rounded-2xl focus:border-[#19c880] focus:outline-none transition">
    </div>

    <div>
        <label class="block text-sm font-bold text-gray-700 mb-2">Payment Screenshot *</label>
        <input type="file" id="screenshotInput" accept="image/*" 
            class="w-full px-4 py-3 border-2 border-gray-200 rounded-2xl focus:border-[#19c880] focus:outline-none transition">
        <p class="text-xs text-gray-500 mt-1">Upload proof of payment</p>
    </div>

    <button onclick="submitPaymentProof()" id="submitPaymentBtn"
        class="w-full bg-[#19c880] hover:bg-[#15a869] text-white font-bold py-4 rounded-xl transition shadow-lg">
        <i class="fas fa-paper-plane mr-2"></i>Submit for Verification
    </button>

    <div id="paymentMessage" class="hidden"></div>

    <button onclick="closePaymentModal()"
        class="w-full text-gray-400 text-sm font-bold py-2 hover:text-red-400 transition">
        Cancel
    </button>
</div>
`;

    document.getElementById('paymentContent').innerHTML = paymentHTML;
    document.getElementById('paymentModal').classList.add('active');
    
    // Store payment data for submission
    window.currentPaymentData = { plan, amount, books };
}

async function submitPaymentProof() {
    const transactionId = document.getElementById('transactionIdInput').value.trim();
    const screenshot = document.getElementById('screenshotInput').files[0];
    const btn = document.getElementById('submitPaymentBtn');
    const msg = document.getElementById('paymentMessage');

    if (!transactionId || transactionId.length < 6) {
        msg.className = 'p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm';
        msg.textContent = 'Please enter a valid transaction ID (6+ characters)';
        msg.classList.remove('hidden');
        return;
    }

    if (!screenshot) {
        msg.className = 'p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm';
        msg.textContent = 'Please upload payment screenshot';
        msg.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Uploading...';

    try {
        // First create payment link
        const linkData = await createPaymentOrder(
            window.currentPaymentData.plan, 
            window.currentPaymentData.books
        );
        
        if (!linkData) {
            throw new Error('Failed to create payment link');
        }

        // Then submit proof
        const formData = new FormData();
        formData.append('transactionId', transactionId);
        formData.append('screenshot', screenshot);

        const response = await fetch(`/api/payment/submit/${linkData.linkId}`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.success) {
            msg.className = 'p-4 bg-green-50 border border-green-200 rounded-xl text-green-700 text-sm';
            msg.innerHTML = '<i class="fas fa-check-circle mr-2"></i>Payment submitted! Admin will verify within 24 hours.';
            msg.classList.remove('hidden');
            btn.innerHTML = '<i class="fas fa-check mr-2"></i>Submitted';
            alert('✅ Payment submitted successfully!\n\nOnce admin approves your payment, you can immediately enjoy full access to this website.');
            setTimeout(() => closePaymentModal(), 3000);
        } else {
            msg.className = 'p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm';
            msg.textContent = data.error || 'Submission failed';
            msg.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Submit for Verification';
        }
    } catch (error) {
        msg.className = 'p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm';
        msg.textContent = 'Error: ' + error.message;
        msg.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>Submit for Verification';
    }
}
</script>
