/**
 * MCDR Settlement Portal — app.js
 * Single-Page Application logic connecting to NestJS API & Keycloak OIDC.
 */

(function () {
  'use strict';

  // ============================================================
  // 1. CONFIGURATION
  // ============================================================
  const CONFIG = {
    API_BASE: 'http://localhost:3000/api',
    KEYCLOAK_URL: 'http://localhost:8081',
    REALM: 'mcdr',
    CLIENT_ID: 'mcdr-owner-portal',
    NOTIF_POLL_INTERVAL: 20000,
    HEALTH_POLL_INTERVAL: 15000,
  };

  // ============================================================
  // 2. AUTH & TOKEN MANAGEMENT
  // ============================================================
  const Auth = {
    getTokens() {
      try {
        const data = localStorage.getItem('mcdr_auth');
        return data ? JSON.parse(data) : null;
      } catch (e) {
        return null;
      }
    },

    setTokens(authData) {
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + (authData.expires_in || 300);
      const payload = Auth.decodeJwt(authData.access_token);
      const roles = payload?.realm_access?.roles || [];
      const userRole = roles.includes('backoffice_employee') ? 'backoffice' : 'owner';

      const storedData = {
        access_token: authData.access_token,
        refresh_token: authData.refresh_token,
        expires_at: expiresAt,
        role: userRole,
        username: payload?.preferred_username || payload?.sub || 'User',
        email: payload?.email || '',
        roles: roles,
      };

      localStorage.setItem('mcdr_auth', JSON.stringify(storedData));
      return storedData;
    },

    clear() {
      localStorage.removeItem('mcdr_auth');
    },

    decodeJwt(token) {
      if (!token) return null;
      try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(
          atob(base64)
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        );
        return JSON.parse(jsonPayload);
      } catch (e) {
        console.error('Failed to decode JWT', e);
        return null;
      }
    },

    getUser() {
      return Auth.getTokens();
    },

    isAuthenticated() {
      const auth = Auth.getTokens();
      if (!auth || !auth.access_token) return false;
      const now = Math.floor(Date.now() / 1000);
      return auth.expires_at > now;
    },

    needsRefresh() {
      const auth = Auth.getTokens();
      if (!auth || !auth.expires_at) return false;
      const now = Math.floor(Date.now() / 1000);
      return auth.expires_at - now < 60; // Refresh if within 60s of expiry
    },

    async login(username, password) {
      const tokenEndpoint = `${CONFIG.KEYCLOAK_URL}/realms/${CONFIG.REALM}/protocol/openid-connect/token`;
      const body = new URLSearchParams({
        grant_type: 'password',
        client_id: CONFIG.CLIENT_ID,
        username: username.trim(),
        password: password,
      });

      const res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error_description || 'Invalid credentials or login failure.');
      }

      const data = await res.json();
      return Auth.setTokens(data);
    },

    async refresh() {
      const auth = Auth.getTokens();
      if (!auth || !auth.refresh_token) {
        Auth.clear();
        throw new Error('No refresh token available');
      }

      const tokenEndpoint = `${CONFIG.KEYCLOAK_URL}/realms/${CONFIG.REALM}/protocol/openid-connect/token`;
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CONFIG.CLIENT_ID,
        refresh_token: auth.refresh_token,
      });

      const res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!res.ok) {
        Auth.clear();
        throw new Error('Session expired, please sign in again.');
      }

      const data = await res.json();
      return Auth.setTokens(data);
    },

    async register(data) {
      const res = await fetch(`${CONFIG.API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: data.email.trim(),
          firstName: data.firstName.trim(),
          lastName: data.lastName.trim(),
          password: data.password,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = Array.isArray(err.message) ? err.message.join(', ') : err.message || 'Registration failed.';
        throw new Error(msg);
      }

      return await res.json();
    },

    logout() {
      Auth.clear();
      Notify.stopPolling();
      Router.navigate('#login');
      Toast.show('Logged out successfully', 'info');
    },
  };

  // ============================================================
  // 3. API CLIENT (FETCH WRAPPER)
  // ============================================================
  const ApiClient = {
    async request(endpoint, options = {}) {
      if (Auth.isAuthenticated() && Auth.needsRefresh()) {
        try {
          await Auth.refresh();
        } catch (e) {
          Auth.logout();
          throw e;
        }
      }

      const auth = Auth.getTokens();
      const headers = { ...options.headers };

      if (auth && auth.access_token) {
        headers['Authorization'] = `Bearer ${auth.access_token}`;
      }

      let url = `${CONFIG.API_BASE}${endpoint}`;
      if (options.query) {
        const params = new URLSearchParams();
        Object.entries(options.query).forEach(([k, v]) => {
          if (v !== undefined && v !== null && v !== '') {
            params.append(k, v);
          }
        });
        const qStr = params.toString();
        if (qStr) url += `?${qStr}`;
      }

      let body = options.body;
      if (body && typeof body === 'object' && !(body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }

      let response;
      try {
        response = await fetch(url, {
          method: options.method || 'GET',
          headers,
          body,
        });
      } catch (networkError) {
        throw new Error('Network error. Unable to reach API server.');
      }

      // Handle 401 Unauthorized -> Refresh once & retry
      if (response.status === 401 && auth?.refresh_token && !options._isRetry) {
        try {
          await Auth.refresh();
          return ApiClient.request(endpoint, { ...options, _isRetry: true });
        } catch (refreshErr) {
          Auth.logout();
          throw new Error('Session expired. Please log in again.');
        }
      }

      if (!response.ok) {
        let errorMsg = `Request failed (${response.status})`;
        try {
          const errJson = await response.json();
          if (errJson.message) {
            errorMsg = Array.isArray(errJson.message) ? errJson.message.join(', ') : errJson.message;
          }
        } catch (e) {}
        throw new Error(errorMsg);
      }

      if (options.rawBlob) {
        return {
          blob: await response.blob(),
          filename: ApiClient.parseFilename(response.headers.get('Content-Disposition')),
          contentType: response.headers.get('Content-Type'),
        };
      }

      if (response.status === 204) return null;
      return await response.json().catch(() => null);
    },

    parseFilename(contentDisposition) {
      if (!contentDisposition) return 'document';
      const match = contentDisposition.match(/filename=["']?([^"';]+)["']?/);
      return match ? match[1] : 'document';
    },

    // Specific API helpers
    checkCrnEligibility(crn) {
      return ApiClient.request(`/crn/${encodeURIComponent(crn)}/eligibility`);
    },

    createSettlementRequest(formData) {
      return ApiClient.request('/settlement-requests', {
        method: 'POST',
        body: formData,
      });
    },

    getMySettlementRequest() {
      return ApiClient.request('/settlement-requests/mine');
    },

    getAllSettlementRequests(query = {}) {
      return ApiClient.request('/settlement-requests', { query });
    },

    getSettlementRequestById(id) {
      return ApiClient.request(`/settlement-requests/${id}`);
    },

    setMeetingFee(requestId, meetingId, fee) {
      return ApiClient.request(`/settlement-requests/${requestId}/meetings/${meetingId}/fee`, {
        method: 'PATCH',
        body: { fee: Number(fee) },
      });
    },

    approveRequest(requestId) {
      return ApiClient.request(`/settlement-requests/${requestId}/approve`, {
        method: 'POST',
      });
    },

    rejectRequest(requestId, rejectionReason) {
      return ApiClient.request(`/settlement-requests/${requestId}/reject`, {
        method: 'POST',
        body: { rejectionReason },
      });
    },

    getPaymentSummary(requestId) {
      return ApiClient.request(`/settlement-requests/${requestId}/payment-summary`);
    },

    payRequest(requestId) {
      return ApiClient.request(`/settlement-requests/${requestId}/pay`, {
        method: 'POST',
      });
    },

    uploadSettlementDoc(requestId, meetingId, file) {
      const fd = new FormData();
      fd.append('file', file);
      return ApiClient.request(`/settlement-requests/${requestId}/meetings/${meetingId}/settlement-document`, {
        method: 'POST',
        body: fd,
      });
    },

    getAttachment(requestId, meetingId) {
      return ApiClient.request(`/settlement-requests/${requestId}/meetings/${meetingId}/attachment`, {
        rawBlob: true,
      });
    },

    getSettlementDoc(requestId, meetingId) {
      return ApiClient.request(`/settlement-requests/${requestId}/meetings/${meetingId}/settlement-document`, {
        rawBlob: true,
      });
    },

    getNotifications() {
      return ApiClient.request('/notifications');
    },

    markNotificationRead(id) {
      return ApiClient.request(`/notifications/${id}/read`, {
        method: 'PATCH',
      });
    },

    checkHealth() {
      return fetch(`${CONFIG.API_BASE}/health`).then((res) => res.json());
    },
  };

  // ============================================================
  // 4. TOAST & MODAL UI HELPERS
  // ============================================================
  const Toast = {
    show(message, type = 'info', duration = 4000) {
      const root = document.getElementById('toast-root');
      if (!root) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type} pointer-events-auto shadow-lg flex items-center justify-between gap-3`;

      const iconSvg = {
        success: '<svg class="w-5 h-5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>',
        error: '<svg class="w-5 h-5 text-rose-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>',
        warning: '<svg class="w-5 h-5 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>',
        info: '<svg class="w-5 h-5 text-sky-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
      }[type] || '';

      toast.innerHTML = `
        <div class="flex items-center gap-2.5 min-w-0">
          ${iconSvg}
          <span class="text-sm font-medium text-slate-100 truncate">${message}</span>
        </div>
        <button class="text-slate-400 hover:text-white shrink-0 ml-2" onclick="this.parentElement.remove()">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      `;

      root.appendChild(toast);
      setTimeout(() => {
        if (toast.parentElement) toast.remove();
      }, duration);
    },
  };

  const Modal = {
    open({ title, bodyHtml, footerButtons = [] }) {
      const modalRoot = document.getElementById('modal-root');
      const modalCard = document.getElementById('modal-card');
      const modalBody = document.getElementById('modal-body');

      let buttonsHtml = footerButtons
        .map(
          (btn) => `
        <button id="${btn.id}" class="${btn.class || 'btn-secondary'}">${btn.label}</button>
      `
        )
        .join('');

      modalBody.innerHTML = `
        <div class="flex items-center justify-between pb-4 border-b border-white/10 mb-4">
          <h3 class="text-lg font-bold text-white">${title}</h3>
          <button data-close-modal class="text-slate-400 hover:text-white p-1 rounded-lg">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="space-y-4 text-slate-300 text-sm mb-6">${bodyHtml}</div>
        ${footerButtons.length ? `<div class="flex items-center justify-end gap-3 pt-4 border-t border-white/10">${buttonsHtml}</div>` : ''}
      `;

      modalRoot.classList.remove('hidden');

      // Bind close buttons
      modalRoot.querySelectorAll('[data-close-modal]').forEach((el) => {
        el.onclick = () => Modal.close();
      });

      // Bind custom footer button actions
      footerButtons.forEach((btn) => {
        const btnEl = document.getElementById(btn.id);
        if (btnEl && btn.onClick) {
          btnEl.onclick = (e) => btn.onClick(e, Modal.close);
        }
      });
    },

    close() {
      const modalRoot = document.getElementById('modal-root');
      if (modalRoot) modalRoot.classList.add('hidden');
    },
  };

  // ============================================================
  // 5. NOTIFICATION SYSTEM
  // ============================================================
  const Notify = {
    timer: null,

    startPolling() {
      Notify.stopPolling();
      Notify.fetch();
      Notify.timer = setInterval(() => Notify.fetch(), CONFIG.NOTIF_POLL_INTERVAL);
    },

    stopPolling() {
      if (Notify.timer) clearInterval(Notify.timer);
      Notify.timer = null;
    },

    async fetch() {
      if (!Auth.isAuthenticated()) return;
      try {
        const data = await ApiClient.getNotifications();
        if (data) {
          Notify.render(data.notifications || [], data.unreadCount || 0);
        }
      } catch (e) {
        console.warn('Failed to poll notifications', e);
      }
    },

    render(notifications, unreadCount) {
      const badge = document.getElementById('notif-badge');
      if (badge) {
        if (unreadCount > 0) {
          badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }

      const panel = document.getElementById('notif-panel');
      if (!panel) return;

      if (notifications.length === 0) {
        panel.innerHTML = `
          <div class="glass-card p-4 text-center text-xs text-slate-400">
            No notifications yet.
          </div>
        `;
        return;
      }

      const listHtml = notifications
        .slice(0, 8)
        .map(
          (n) => `
        <div class="p-3 border-b border-white/5 last:border-0 flex items-start gap-3 ${n.isRead ? 'opacity-60' : 'bg-brand-500/5'} rounded-lg">
          <div class="w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.isRead ? 'bg-slate-600' : 'bg-brand-400'}"></div>
          <div class="flex-1 min-w-0">
            <p class="text-xs text-slate-200">${n.message}</p>
            <span class="text-[10px] text-slate-400 mt-1 block">${new Date(n.createdAt).toLocaleString()}</span>
          </div>
          ${
            !n.isRead
              ? `<button data-read-id="${n.id}" class="text-[10px] text-brand-400 hover:underline shrink-0">Mark read</button>`
              : ''
          }
        </div>
      `
        )
        .join('');

      panel.innerHTML = `
        <div class="glass-card p-3 shadow-glass">
          <div class="flex items-center justify-between pb-2 mb-2 border-b border-white/10">
            <span class="text-xs font-bold text-white uppercase tracking-wider">Notifications</span>
            <span class="text-[10px] text-slate-400">${unreadCount} unread</span>
          </div>
          <div class="max-h-72 overflow-y-auto space-y-1">${listHtml}</div>
        </div>
      `;

      panel.querySelectorAll('[data-read-id]').forEach((btn) => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-read-id');
          try {
            await ApiClient.markNotificationRead(id);
            Notify.fetch();
          } catch (err) {
            Toast.show('Failed to mark read', 'error');
          }
        };
      });
    },
  };

  // ============================================================
  // 6. ROUTER & VIEW RENDERING
  // ============================================================
  const Router = {
    init() {
      window.addEventListener('hashchange', () => Router.handleRoute());
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href^="#"]');
        if (link) {
          const hash = link.getAttribute('href');
          if (hash === '#/') {
            e.preventDefault();
            Router.defaultRoute();
          }
        }
      });
      Router.handleRoute();
    },

    defaultRoute() {
      const user = Auth.getUser();
      if (!user) {
        Router.navigate('#login');
      } else if (user.role === 'backoffice') {
        Router.navigate('#backoffice/queue');
      } else {
        Router.navigate('#owner/mine');
      }
    },

    navigate(hash) {
      window.location.hash = hash;
    },

    async handleRoute() {
      const hash = window.location.hash || '#login';
      const user = Auth.getUser();

      // UI Shell Visibility
      const authView = document.getElementById('auth-view');
      const appShell = document.getElementById('app-shell');

      if (!Auth.isAuthenticated()) {
        authView.classList.remove('hidden');
        appShell.classList.add('hidden');
        Notify.stopPolling();
        LoginController.init();
        return;
      }

      authView.classList.add('hidden');
      appShell.classList.remove('hidden');
      HeaderController.render(user);
      Notify.startPolling();

      const mainContent = document.getElementById('main-content');
      mainContent.innerHTML = '';

      // Route Dispatching & Role Guarding
      if (hash.startsWith('#login')) {
        Router.defaultRoute();
        return;
      }

      if (user.role === 'owner') {
        if (hash === '#owner/new') {
          OwnerNewRequestController.render(mainContent);
        } else {
          // Default owner route: #owner/mine
          OwnerTrackerController.render(mainContent);
        }
      } else if (user.role === 'backoffice') {
        if (hash.startsWith('#backoffice/detail/')) {
          const id = hash.replace('#backoffice/detail/', '');
          BackofficeDetailController.render(mainContent, id);
        } else {
          // Default backoffice route: #backoffice/queue
          BackofficeQueueController.render(mainContent);
        }
      }
    },
  };

  // ============================================================
  // 7. HEADER & USER MENU CONTROLLER
  // ============================================================
  const HeaderController = {
    render(user) {
      const nameEl = document.getElementById('user-name');
      const avatarEl = document.getElementById('user-avatar');
      const navEl = document.getElementById('main-nav');
      const mobileNavEl = document.getElementById('mobile-nav');

      if (nameEl) nameEl.textContent = user.username || 'User';
      if (avatarEl) avatarEl.textContent = (user.username || 'U')[0].toUpperCase();

      // Nav Links per role
      let navHtml = '';
      if (user.role === 'owner') {
        navHtml = `
          <a href="#owner/mine" class="nav-link ${window.location.hash === '#owner/mine' || !window.location.hash ? 'active' : ''}">My Settlement Request</a>
          <a href="#owner/new" class="nav-link ${window.location.hash === '#owner/new' ? 'active' : ''}">New Settlement Request</a>
        `;
      } else {
        navHtml = `
          <a href="#backoffice/queue" class="nav-link ${window.location.hash.startsWith('#backoffice') ? 'active' : ''}">Requests Queue</a>
        `;
      }

      if (navEl) navEl.innerHTML = navHtml;
      if (mobileNavEl) mobileNavEl.innerHTML = navHtml;

      // Bind User Menu Dropdown
      const userBtn = document.getElementById('user-menu-btn');
      const userMenu = document.getElementById('user-menu');
      if (userBtn && userMenu) {
        userMenu.innerHTML = `
          <div class="glass-card p-3 shadow-glass">
            <div class="px-2 py-1.5 border-b border-white/10 mb-1">
              <p class="text-xs font-semibold text-white">${user.username}</p>
              <p class="text-[10px] text-slate-400 capitalize">${user.role} role</p>
            </div>
            <button id="logout-btn" class="w-full text-left px-2 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 rounded transition flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
              Sign out
            </button>
          </div>
        `;

        userBtn.onclick = (e) => {
          e.stopPropagation();
          userMenu.classList.toggle('hidden');
        };

        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) logoutBtn.onclick = () => Auth.logout();
      }

      // Bind Notification Bell Toggle
      const notifBell = document.getElementById('notif-bell');
      const notifPanel = document.getElementById('notif-panel');
      if (notifBell && notifPanel) {
        notifBell.onclick = (e) => {
          e.stopPropagation();
          notifPanel.classList.toggle('hidden');
        };
      }

      // Bind Mobile Menu Toggle
      const mobileBtn = document.getElementById('mobile-menu-btn');
      if (mobileBtn && mobileNavEl) {
        mobileBtn.onclick = () => mobileNavEl.classList.toggle('hidden');
      }

      // Close dropdowns on outside click
      document.onclick = () => {
        if (userMenu) userMenu.classList.add('hidden');
        if (notifPanel) notifPanel.classList.add('hidden');
      };
    },
  };

  // ============================================================
  // 8. LOGIN / REGISTER CONTROLLER
  // ============================================================
  const LoginController = {
    init() {
      const tabLogin = document.getElementById('tab-login');
      const tabRegister = document.getElementById('tab-register');
      const loginForm = document.getElementById('login-form');
      const registerForm = document.getElementById('register-form');
      const loginErr = document.getElementById('login-error');
      const regErr = document.getElementById('register-error');
      const regSuccess = document.getElementById('register-success');

      if (!tabLogin) return;

      tabLogin.classList.add('active');
      tabRegister.classList.remove('active');

      tabLogin.onclick = () => {
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
        loginForm.classList.remove('hidden');
        registerForm.classList.add('hidden');
      };

      tabRegister.onclick = () => {
        tabRegister.classList.add('active');
        tabLogin.classList.remove('active');
        registerForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
      };

      // Password Toggles
      document.querySelectorAll('[data-toggle-pwd]').forEach((btn) => {
        btn.onclick = () => {
          const targetId = btn.getAttribute('data-toggle-pwd');
          const input = document.getElementById(targetId);
          if (!input) return;
          const isPassword = input.type === 'password';
          input.type = isPassword ? 'text' : 'password';
          btn.querySelector('.eye-open').classList.toggle('hidden', !isPassword);
          btn.querySelector('.eye-closed').classList.toggle('hidden', isPassword);
        };
      });

      // Login Submission
      loginForm.onsubmit = async (e) => {
        e.preventDefault();
        loginErr.classList.add('hidden');
        const submitBtn = document.getElementById('login-submit');
        setLoading(submitBtn, true);

        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        try {
          await Auth.login(username, password);
          Toast.show('Welcome back!', 'success');
          Router.defaultRoute();
        } catch (err) {
          loginErr.textContent = err.message;
          loginErr.classList.remove('hidden');
        } finally {
          setLoading(submitBtn, false);
        }
      };

      // Register Submission
      registerForm.onsubmit = async (e) => {
        e.preventDefault();
        regErr.classList.add('hidden');
        regSuccess.classList.add('hidden');
        const submitBtn = document.getElementById('register-submit');
        setLoading(submitBtn, true);

        const data = {
          firstName: document.getElementById('reg-firstName').value,
          lastName: document.getElementById('reg-lastName').value,
          email: document.getElementById('reg-email').value,
          password: document.getElementById('reg-password').value,
        };

        try {
          await Auth.register(data);
          regSuccess.textContent = 'Account created successfully! You can now sign in.';
          regSuccess.classList.remove('hidden');
          registerForm.reset();
          setTimeout(() => tabLogin.click(), 1500);
        } catch (err) {
          regErr.textContent = err.message;
          regErr.classList.remove('hidden');
        } finally {
          setLoading(submitBtn, false);
        }
      };
    },
  };

  // Helper for button loading state
  function setLoading(btn, isLoading) {
    if (!btn) return;
    const label = btn.querySelector('.btn-label');
    const spinner = btn.querySelector('.btn-spinner');
    btn.disabled = isLoading;
    if (label) label.classList.toggle('opacity-0', isLoading);
    if (spinner) spinner.classList.toggle('hidden', !isLoading);
  }

  // ============================================================
  // 9. OWNER: NEW SETTLEMENT REQUEST CONTROLLER (MULTI-STEP)
  // ============================================================
  const OwnerNewRequestController = {
    meetings: [],

    async render(container) {
      // First check if owner already has an active request
      let existingReq = null;
      try {
        const res = await ApiClient.getMySettlementRequest();
        existingReq = res?.request || null;
      } catch (e) {}

      if (existingReq && existingReq.status !== 'REJECTED') {
        container.innerHTML = `
          <div class="glass-card p-8 text-center max-w-lg mx-auto">
            <div class="w-12 h-12 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center mx-auto mb-4">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            </div>
            <h2 class="text-xl font-bold text-white mb-2">Active Request Exists</h2>
            <p class="text-sm text-slate-300 mb-6">You already have a settlement request in progress (Status: <strong class="text-brand-300">${existingReq.status}</strong>). Only one active request is allowed at a time.</p>
            <a href="#owner/mine" class="btn-primary inline-flex">View My Request</a>
          </div>
        `;
        return;
      }

      OwnerNewRequestController.meetings = [
        { meetingDate: '', capitalAtMeeting: '' },
      ];

      container.innerHTML = `
        <div class="max-w-3xl mx-auto space-y-6 animate-fade-in">
          <div>
            <h2 class="text-2xl font-extrabold text-white tracking-tight">Create Settlement Request</h2>
            <p class="text-sm text-slate-400 mt-1">Submit your Commercial Registration Number and capital meeting documents.</p>
          </div>

          <form id="new-request-form" class="glass-card p-6 sm:p-8 space-y-6">
            
            <!-- STEP 1: CRN Input & Verification -->
            <div class="space-y-4 pb-6 border-b border-white/10">
              <div class="flex items-center justify-between">
                <label for="crn-input" class="block text-sm font-bold text-slate-200">1. Commercial Registration Number (CRN)</label>
                <span id="crn-badge" class="hidden text-xs px-2.5 py-0.5 rounded-full font-semibold"></span>
              </div>
              <div class="flex gap-3">
                <input id="crn-input" type="text" required placeholder="e.g. CRN10001" class="form-input flex-1" />
                <button type="button" id="check-crn-btn" class="btn-secondary shrink-0">
                  <span>Verify Eligibility</span>
                </button>
              </div>
              <p id="crn-hint" class="text-xs text-slate-400">Must be 5 to 20 alphanumeric characters.</p>
            </div>

            <!-- STEP 2: Meetings & Attachments -->
            <div class="space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <h3 class="text-sm font-bold text-slate-200">2. Capital Meetings & Documents</h3>
                  <p class="text-xs text-slate-400">Provide meeting details and upload one attachment per meeting (PDF/JPG/PNG, ≤10MB).</p>
                </div>
                <button type="button" id="add-meeting-btn" class="btn-secondary text-xs px-3 py-1.5">+ Add Meeting</button>
              </div>

              <div id="meetings-container" class="space-y-4"></div>
            </div>

            <!-- Submission Errors -->
            <p id="form-error" class="hidden text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-4 py-3"></p>

            <!-- Actions -->
            <div class="flex justify-end gap-3 pt-4 border-t border-white/10">
              <a href="#owner/mine" class="btn-secondary">Cancel</a>
              <button type="submit" id="submit-request-btn" class="btn-primary">
                <span class="btn-label">Submit Request</span>
                <span class="btn-spinner hidden"></span>
              </button>
            </div>
          </form>
        </div>
      `;

      OwnerNewRequestController.bindEvents(container);
    },

    bindEvents(container) {
      const crnInput = container.querySelector('#crn-input');
      const checkBtn = container.querySelector('#check-crn-btn');
      const crnBadge = container.querySelector('#crn-badge');
      const crnHint = container.querySelector('#crn-hint');
      let crnVerified = false;

      checkBtn.onclick = async () => {
        const val = crnInput.value.trim();
        if (!val || val.length < 5 || val.length > 20 || !/^[a-zA-Z0-9]+$/.test(val)) {
          Toast.show('CRN must be 5-20 alphanumeric characters', 'warning');
          return;
        }

        checkBtn.disabled = true;
        try {
          const res = await ApiClient.checkCrnEligibility(val);
          crnBadge.classList.remove('hidden', 'bg-emerald-500/20', 'text-emerald-400', 'bg-amber-500/20', 'text-amber-400');
          if (res.needsSettlement) {
            crnBadge.classList.add('bg-emerald-500/20', 'text-emerald-400');
            crnBadge.textContent = 'Eligible for Settlement';
            crnHint.textContent = 'CRN verified and eligible for capital settlement.';
            crnVerified = true;
          } else {
            crnBadge.classList.add('bg-amber-500/20', 'text-amber-400');
            crnBadge.textContent = 'No Settlement Needed';
            crnHint.textContent = 'This CRN does not require settlement.';
            crnVerified = false;
          }
        } catch (err) {
          Toast.show(err.message, 'error');
        } finally {
          checkBtn.disabled = false;
        }
      };

      const addBtn = container.querySelector('#add-meeting-btn');
      addBtn.onclick = () => {
        OwnerNewRequestController.meetings.push({ meetingDate: '', capitalAtMeeting: '' });
        OwnerNewRequestController.renderMeetingsList(container);
      };

      OwnerNewRequestController.renderMeetingsList(container);

      // Form submission
      const form = container.querySelector('#new-request-form');
      const formErr = container.querySelector('#form-error');
      const submitBtn = container.querySelector('#submit-request-btn');

      form.onsubmit = async (e) => {
        e.preventDefault();
        formErr.classList.add('hidden');

        const crnVal = crnInput.value.trim();
        if (!crnVal) {
          Toast.show('Please enter a valid CRN', 'warning');
          return;
        }

        const formData = new FormData();
        const payloadMeetings = [];

        const meetingRows = container.querySelectorAll('.meeting-row');
        if (meetingRows.length === 0) {
          Toast.show('Please add at least one meeting', 'warning');
          return;
        }

        for (let i = 0; i < meetingRows.length; i++) {
          const row = meetingRows[i];
          const dateVal = row.querySelector('.meeting-date').value;
          const capVal = row.querySelector('.meeting-cap').value;
          const fileInput = row.querySelector('.meeting-file');
          const file = fileInput.files[0];

          if (!dateVal || !capVal || Number(capVal) <= 0) {
            Toast.show(`Please fill out valid details for Meeting #${i + 1}`, 'warning');
            return;
          }

          if (!file) {
            Toast.show(`Please select an attachment file for Meeting #${i + 1}`, 'warning');
            return;
          }

          payloadMeetings.push({
            meetingDate: dateVal,
            capitalAtMeeting: Number(capVal),
          });

          formData.append('attachments', file);
        }

        const payloadObj = {
          crn: crnVal,
          meetings: payloadMeetings,
        };

        // Backend ParseJsonPayloadPipe expects field name 'payload' as JSON string!
        formData.append('payload', JSON.stringify(payloadObj));

        setLoading(submitBtn, true);
        try {
          await ApiClient.createSettlementRequest(formData);
          Toast.show('Settlement request submitted successfully!', 'success');
          Router.navigate('#owner/mine');
        } catch (err) {
          formErr.textContent = err.message;
          formErr.classList.remove('hidden');
        } finally {
          setLoading(submitBtn, false);
        }
      };
    },

    renderMeetingsList(container) {
      const listEl = container.querySelector('#meetings-container');
      const todayStr = new Date().toISOString().split('T')[0];

      listEl.innerHTML = OwnerNewRequestController.meetings
        .map(
          (m, idx) => `
        <div class="meeting-row bg-ink-800/60 border border-white/5 rounded-xl p-4 space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-brand-300 uppercase tracking-wider">Meeting #${idx + 1}</span>
            ${
              OwnerNewRequestController.meetings.length > 1
                ? `<button type="button" data-remove-idx="${idx}" class="text-xs text-rose-400 hover:underline">Remove</button>`
                : ''
            }
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">Meeting Date</label>
              <input type="date" max="${todayStr}" required class="form-input meeting-date" value="${m.meetingDate || ''}" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-300 mb-1">Capital at Meeting (EGP)</label>
              <input type="number" min="1" step="any" required placeholder="e.g. 500000" class="form-input meeting-cap" value="${m.capitalAtMeeting || ''}" />
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Meeting Minutes Attachment (PDF, JPG, PNG ≤10MB)</label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png" required class="form-input meeting-file text-xs file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-brand-500/20 file:text-brand-300 hover:file:bg-brand-500/30" />
          </div>
        </div>
      `
        )
        .join('');

      listEl.querySelectorAll('[data-remove-idx]').forEach((btn) => {
        btn.onclick = () => {
          const idx = parseInt(btn.getAttribute('data-remove-idx'), 10);
          OwnerNewRequestController.meetings.splice(idx, 1);
          OwnerNewRequestController.renderMeetingsList(container);
        };
      });
    },
  };

  // ============================================================
  // 10. OWNER: REQUEST TRACKER & PAYMENT CONTROLLER
  // ============================================================
  const OwnerTrackerController = {
    async render(container) {
      container.innerHTML = `
        <div class="flex items-center justify-center min-h-[300px]">
          <div class="spinner w-8 h-8 text-brand-400"></div>
        </div>
      `;

      try {
        const res = await ApiClient.getMySettlementRequest();
        const req = res?.request || null;
        if (!req) {
          OwnerTrackerController.renderEmptyState(container);
          return;
        }
        OwnerTrackerController.renderTracker(container, req);
      } catch (err) {
        if (err.message.includes('404') || err.message.includes('not found')) {
          OwnerTrackerController.renderEmptyState(container);
        } else {
          container.innerHTML = `
            <div class="glass-card p-6 text-center max-w-md mx-auto">
              <p class="text-rose-400 text-sm mb-4">${err.message}</p>
              <button onclick="window.location.reload()" class="btn-secondary text-xs">Retry</button>
            </div>
          `;
        }
      }
    },

    renderEmptyState(container) {
      container.innerHTML = `
        <div class="glass-card p-10 text-center max-w-md mx-auto space-y-4 animate-scale-in">
          <div class="w-16 h-16 rounded-2xl bg-brand-500/10 text-brand-400 flex items-center justify-center mx-auto mb-2">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          </div>
          <h2 class="text-xl font-extrabold text-white">No Settlement Request</h2>
          <p class="text-xs text-slate-400">You haven't submitted any capital settlement request yet. Start your first application now.</p>
          <a href="#owner/new" class="btn-primary inline-flex mt-2">+ Create Settlement Request</a>
        </div>
      `;
    },

    renderTracker(container, req) {
      const steps = [
        { key: 'PENDING_REVIEW', label: 'Pending Review' },
        { key: 'AWAITING_PAYMENT', label: 'Awaiting Payment' },
        { key: 'AWAITING_SETTLEMENT', label: 'Awaiting Settlement' },
        { key: 'SETTLED', label: 'Settled' },
      ];

      const isRejected = req.status === 'REJECTED';
      let currentStepIdx = steps.findIndex((s) => s.key === req.status);
      if (currentStepIdx === -1) currentStepIdx = 0;

      const stepperHtml = isRejected
        ? `
          <div class="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 text-center">
            <span class="inline-flex items-center gap-2 text-rose-400 font-bold text-sm">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
              Request Rejected
            </span>
            ${req.rejectionReason ? `<p class="text-xs text-slate-300 mt-1">Reason: "${req.rejectionReason}"</p>` : ''}
            <div class="mt-4">
              <a href="#owner/new" class="btn-primary text-xs inline-flex">Submit New Request</a>
            </div>
          </div>
        `
        : `
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${steps
              .map((s, idx) => {
                const isComplete = idx < currentStepIdx || req.status === 'SETTLED';
                const isCurrent = idx === currentStepIdx && req.status !== 'SETTLED';

                let dotClass = 'bg-slate-700 text-slate-400 border-slate-600';
                if (isComplete) dotClass = 'bg-brand-500 text-white border-brand-400 shadow-glow';
                if (isCurrent) dotClass = 'bg-amber-500 text-white border-amber-400 animate-pulse';

                return `
                <div class="flex flex-col items-center text-center p-3 rounded-xl ${isCurrent ? 'bg-amber-500/5 border border-amber-500/20' : 'bg-ink-800/40'}">
                  <div class="w-8 h-8 rounded-full border-2 flex items-center justify-center font-bold text-xs mb-2 ${dotClass}">
                    ${isComplete ? '✓' : idx + 1}
                  </div>
                  <span class="text-xs font-semibold ${isCurrent ? 'text-amber-300' : isComplete ? 'text-slate-200' : 'text-slate-500'}">${s.label}</span>
                </div>
              `;
              })
              .join('')}
          </div>
        `;

      container.innerHTML = `
        <div class="max-w-4xl mx-auto space-y-6 animate-fade-in">
          <!-- Top Bar -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div class="flex items-center gap-3">
                <h2 class="text-2xl font-extrabold text-white tracking-tight">CRN: ${req.crn}</h2>
                <span class="status-badge status-${req.status.toLowerCase()}">${req.status}</span>
              </div>
              <p class="text-xs text-slate-400 mt-1">Submitted on ${new Date(req.createdAt).toLocaleDateString()}</p>
            </div>
            ${
              req.status === 'AWAITING_PAYMENT'
                ? `<button id="pay-now-btn" class="btn-primary shrink-0 shadow-glow">Proceed to Payment</button>`
                : ''
            }
          </div>

          <!-- Stepper -->
          <div class="glass-card p-6">${stepperHtml}</div>

          <!-- Summary & Meetings Card -->
          <div class="glass-card p-6 space-y-6">
            <h3 class="text-base font-bold text-white pb-3 border-b border-white/10">Meetings Overview</h3>

            <div class="space-y-4">
              ${req.meetings
                .map(
                  (m, idx) => `
                <div class="bg-ink-850/60 border border-white/5 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div class="space-y-1">
                    <span class="text-xs font-bold text-brand-400">Meeting #${idx + 1}</span>
                    <p class="text-sm text-slate-200">Date: <strong>${new Date(m.meetingDate).toLocaleDateString()}</strong></p>
                    <p class="text-xs text-slate-400">Capital: <strong>${Number(m.capitalAtMeeting).toLocaleString()} EGP</strong></p>
                    ${m.fee ? `<p class="text-xs text-emerald-400 font-semibold">Assessed Fee: ${Number(m.fee).toLocaleString()} EGP</p>` : ''}
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <!-- Attachment button -->
                    <button data-download-att="${m._id}" class="btn-secondary text-xs px-3 py-1.5">
                      <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                      View Attachment
                    </button>

                    <!-- Settlement Doc button if settled -->
                    ${
                      m.settlementDocumentUrl
                        ? `<button data-download-doc="${m._id}" class="btn-primary text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 border-emerald-500">
                            <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                            Download Settlement Doc
                          </button>`
                        : ''
                    }
                  </div>
                </div>
              `
                )
                .join('')}
            </div>
          </div>
        </div>
      `;

      // Bind Attachment Downloads
      container.querySelectorAll('[data-download-att]').forEach((btn) => {
        btn.onclick = async () => {
          const meetingId = btn.getAttribute('data-download-att');
          try {
            const { blob, filename } = await ApiClient.getAttachment(req.id, meetingId);
            downloadBlob(blob, filename);
          } catch (err) {
            Toast.show(err.message, 'error');
          }
        };
      });

      // Bind Settlement Doc Downloads
      container.querySelectorAll('[data-download-doc]').forEach((btn) => {
        btn.onclick = async () => {
          const meetingId = btn.getAttribute('data-download-doc');
          try {
            const { blob, filename } = await ApiClient.getSettlementDoc(req.id, meetingId);
            downloadBlob(blob, filename);
          } catch (err) {
            Toast.show(err.message, 'error');
          }
        };
      });

      // Bind Payment Action
      const payBtn = container.querySelector('#pay-now-btn');
      if (payBtn) {
        payBtn.onclick = async () => {
          try {
            const summary = await ApiClient.getPaymentSummary(req.id);
            Modal.open({
              title: 'Confirm Payment',
              bodyHtml: `
                <div class="space-y-3">
                  <p class="text-xs text-slate-400">Review your payment details before processing settlement fees.</p>
                  <div class="bg-ink-800 p-4 rounded-xl space-y-2 text-xs">
                    <div class="flex justify-between text-slate-300">
                      <span>                      Total Assessed Fees:</span>
                      <span class="font-bold text-white">${Number(summary.total).toLocaleString()} EGP</span>
                    </div>
                    <div class="flex justify-between text-slate-300">
                      <span>CRN Number:</span>
                      <span class="font-mono text-slate-200">${req.crn}</span>
                    </div>
                  </div>
                </div>
              `,
              footerButtons: [
                { id: 'modal-cancel', label: 'Cancel', class: 'btn-secondary text-xs' },
                {
                  id: 'modal-pay-confirm',
                  label: 'Pay Now',
                  class: 'btn-primary text-xs',
                  onClick: async (e, closeModal) => {
                    const confirmBtn = document.getElementById('modal-pay-confirm');
                    setLoading(confirmBtn, true);
                    try {
                      await ApiClient.payRequest(req.id);
                      Toast.show('Payment processed successfully!', 'success');
                      closeModal();
                      OwnerTrackerController.render(container);
                    } catch (err) {
                      Toast.show(err.message, 'error');
                    } finally {
                      setLoading(confirmBtn, false);
                    }
                  },
                },
              ],
            });
          } catch (err) {
            Toast.show(err.message, 'error');
          }
        };
      }
    },
  };

  // Helper to trigger blob download
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // 11. BACKOFFICE: QUEUE TABLE CONTROLLER
  // ============================================================
  const BackofficeQueueController = {
    query: {
      status: '',
      page: 1,
      limit: 10,
    },

    async render(container) {
      container.innerHTML = `
        <div class="space-y-6 animate-fade-in">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 class="text-2xl font-extrabold text-white tracking-tight">Settlement Queue</h2>
              <p class="text-xs text-slate-400 mt-1">Review, set meeting fees, approve, or upload settlement documents.</p>
            </div>
            
            <!-- Filters -->
            <div class="flex items-center gap-3">
              <select id="status-filter" class="form-select text-xs min-w-[160px]">
                <option value="">All Statuses</option>
                <option value="PENDING_REVIEW">PENDING_REVIEW</option>
                <option value="AWAITING_PAYMENT">AWAITING_PAYMENT</option>
                <option value="AWAITING_SETTLEMENT">AWAITING_SETTLEMENT</option>
                <option value="SETTLED">SETTLED</option>
                <option value="REJECTED">REJECTED</option>
              </select>
            </div>
          </div>

          <!-- Table Container -->
          <div class="glass-card overflow-hidden">
            <div id="queue-table-root" class="overflow-x-auto min-h-[300px] flex items-center justify-center">
              <div class="spinner w-8 h-8 text-brand-400"></div>
            </div>
          </div>
        </div>
      `;

      const select = container.querySelector('#status-filter');
      select.value = BackofficeQueueController.query.status;
      select.onchange = () => {
        BackofficeQueueController.query.status = select.value;
        BackofficeQueueController.query.page = 1;
        BackofficeQueueController.loadTable(container);
      };

      BackofficeQueueController.loadTable(container);
    },

    async loadTable(container) {
      const root = container.querySelector('#queue-table-root');
      try {
        const res = await ApiClient.getAllSettlementRequests(BackofficeQueueController.query);
        const data = res.items || [];
        const total = typeof res.total === 'number' ? res.total : data.length;
        const page = res.page || BackofficeQueueController.query.page;
        const limit = res.limit || BackofficeQueueController.query.limit;
        const totalPages = Math.max(1, Math.ceil(total / limit));

        if (data.length === 0) {
          root.innerHTML = `
            <div class="p-10 text-center text-xs text-slate-400">
              No settlement requests found matching filter criteria.
            </div>
          `;
          return;
        }

        root.innerHTML = `
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-white/10 text-[11px] font-bold text-slate-400 uppercase tracking-wider bg-ink-850/50">
                <th class="py-3 px-4">CRN</th>
                <th class="py-3 px-4">Owner ID</th>
                <th class="py-3 px-4">Meetings</th>
                <th class="py-3 px-4">Status</th>
                <th class="py-3 px-4">Submitted</th>
                <th class="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/5 text-xs text-slate-300">
              ${data
                .map(
                  (req) => `
                <tr class="hover:bg-white/[0.02] transition">
                  <td class="py-3.5 px-4 font-mono font-semibold text-white">${req.crn}</td>
                  <td class="py-3.5 px-4 max-w-[120px] truncate text-slate-400">${req.ownerId}</td>
                  <td class="py-3.5 px-4">${req.meetings ? req.meetings.length : 0} meetings</td>
                  <td class="py-3.5 px-4">
                    <span class="status-badge status-${req.status.toLowerCase()}">${req.status}</span>
                  </td>
                  <td class="py-3.5 px-4 text-slate-400">${new Date(req.createdAt).toLocaleDateString()}</td>
                  <td class="py-3.5 px-4 text-right">
                    <a href="#backoffice/detail/${req.id}" class="btn-secondary text-xs px-3 py-1">Review</a>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
          <div class="flex items-center justify-between px-4 py-3 border-t border-white/5 text-xs text-slate-400">
            <span>Page ${page} of ${totalPages} (${total} total)</span>
            <div class="flex gap-2">
              <button id="prev-page-btn" class="btn-secondary text-xs px-3 py-1" ${page <= 1 ? 'disabled' : ''}>Prev</button>
              <button id="next-page-btn" class="btn-secondary text-xs px-3 py-1" ${page >= totalPages ? 'disabled' : ''}>Next</button>
            </div>
          </div>
        `;
        const prevBtn = root.querySelector('#prev-page-btn');
        const nextBtn = root.querySelector('#next-page-btn');
        if (prevBtn) prevBtn.onclick = () => { BackofficeQueueController.query.page = Math.max(1, page - 1); BackofficeQueueController.loadTable(container); };
        if (nextBtn) nextBtn.onclick = () => { BackofficeQueueController.query.page = Math.min(totalPages, page + 1); BackofficeQueueController.loadTable(container); };
      } catch (err) {
        root.innerHTML = `
          <div class="p-6 text-center text-rose-400 text-xs">
            Failed to load queue: ${err.message}
          </div>
        `;
      }
    },
  };

  // ============================================================
  // 12. BACKOFFICE: DETAIL & REVIEW CONTROLLER
  // ============================================================
  const BackofficeDetailController = {
    async render(container, id) {
      container.innerHTML = `
        <div class="flex items-center justify-center min-h-[300px]">
          <div class="spinner w-8 h-8 text-brand-400"></div>
        </div>
      `;

      try {
        const req = await ApiClient.getSettlementRequestById(id);
        BackofficeDetailController.renderDetail(container, req);
      } catch (err) {
        container.innerHTML = `
          <div class="glass-card p-6 text-center max-w-md mx-auto">
            <p class="text-rose-400 text-sm mb-4">${err.message}</p>
            <a href="#backoffice/queue" class="btn-secondary text-xs">Back to Queue</a>
          </div>
        `;
      }
    },

    renderDetail(container, req) {
      const allFeesSet = req.meetings.every((m) => m.fee !== undefined && m.fee !== null && Number(m.fee) > 0);
      const isPending = req.status === 'PENDING_REVIEW';
      const isAwaitingSettlement = req.status === 'AWAITING_SETTLEMENT';

      container.innerHTML = `
        <div class="max-w-4xl mx-auto space-y-6 animate-fade-in">
          <!-- Header -->
          <div class="flex items-center justify-between">
            <a href="#backoffice/queue" class="text-xs text-slate-400 hover:text-white flex items-center gap-1">
              ← Back to Queue
            </a>
            <span class="status-badge status-${req.status.toLowerCase()}">${req.status}</span>
          </div>

          <div class="glass-card p-6 space-y-4">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-white/10">
              <div>
                <h2 class="text-xl font-extrabold text-white">CRN: ${req.crn}</h2>
                <p class="text-xs text-slate-400">Owner UUID: <span class="font-mono text-slate-300">${req.ownerId}</span></p>
              </div>
              <p class="text-xs text-slate-400">Submitted: ${new Date(req.createdAt).toLocaleString()}</p>
            </div>

            <!-- Meetings & Fee Management -->
            <div class="space-y-4 pt-2">
              <h3 class="text-sm font-bold text-white">Meetings & Fee Assessment</h3>

              <div class="space-y-4">
                ${req.meetings
                  .map(
                    (m, idx) => `
                  <div class="bg-ink-850/60 border border-white/5 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div class="space-y-1">
                      <span class="text-xs font-bold text-brand-300">Meeting #${idx + 1}</span>
                      <p class="text-xs text-slate-200">Date: <strong>${new Date(m.meetingDate).toLocaleDateString()}</strong></p>
                      <p class="text-xs text-slate-400">Capital: <strong>${Number(m.capitalAtMeeting).toLocaleString()} EGP</strong></p>
                    </div>

                    <div class="flex flex-wrap items-center gap-3">
                      <!-- Attachment download -->
                      <button data-att-meeting="${m._id}" class="btn-secondary text-xs px-2.5 py-1">View Attachment</button>

                      <!-- Fee input -->
                      <div class="flex items-center gap-2">
                        <label class="text-xs text-slate-400">Fee (EGP):</label>
                        <input type="number" min="1" step="any" data-fee-input="${m._id}" value="${m.fee || ''}"
                          ${!isPending ? 'disabled' : ''} class="form-input text-xs w-28 py-1 px-2" placeholder="Amount" />
                        ${
                          isPending
                            ? `<button data-save-fee="${m._id}" class="btn-primary text-xs px-2.5 py-1">Save</button>`
                            : ''
                        }
                      </div>

                      <!-- Settlement document upload if awaiting settlement -->
                      ${
                        isAwaitingSettlement
                          ? `<label class="btn-primary text-xs px-3 py-1 cursor-pointer bg-emerald-600 hover:bg-emerald-500 border-emerald-500">
                              <span>${m.settlementDocumentUrl ? 'Update Doc' : 'Upload Settlement Doc'}</span>
                              <input type="file" accept=".pdf,.jpg,.jpeg,.png" data-upload-doc="${m._id}" class="hidden" />
                            </label>`
                          : ''
                      }
                    </div>
                  </div>
                `
                  )
                  .join('')}
              </div>
            </div>

            <!-- Global Action Bar for Review -->
            ${
              isPending
                ? `
              <div class="flex items-center justify-end gap-3 pt-6 border-t border-white/10">
                <button id="reject-btn" class="btn-secondary text-xs text-rose-400 hover:bg-rose-500/10 border-rose-500/20">Reject Request</button>
                <button id="approve-btn" ${!allFeesSet ? 'disabled title="Set fees for all meetings first"' : ''} class="btn-primary text-xs bg-emerald-600 hover:bg-emerald-500 border-emerald-500">Approve Request</button>
              </div>
            `
                : ''
            }
          </div>
        </div>
      `;

      // Bind Attachment Downloads
      container.querySelectorAll('[data-att-meeting]').forEach((btn) => {
        btn.onclick = async () => {
          const meetingId = btn.getAttribute('data-att-meeting');
          try {
            const { blob, filename } = await ApiClient.getAttachment(req.id, meetingId);
            downloadBlob(blob, filename);
          } catch (err) {
            Toast.show(err.message, 'error');
          }
        };
      });

      // Bind Save Fee buttons
      container.querySelectorAll('[data-save-fee]').forEach((btn) => {
        btn.onclick = async () => {
          const meetingId = btn.getAttribute('data-save-fee');
          const input = container.querySelector(`[data-fee-input="${meetingId}"]`);
          const val = input.value;
          if (!val || Number(val) <= 0) {
            Toast.show('Please enter a valid positive fee', 'warning');
            return;
          }
          try {
            await ApiClient.setMeetingFee(req.id, meetingId, val);
            Toast.show('Fee updated successfully', 'success');
            BackofficeDetailController.render(container, req.id);
          } catch (err) {
            Toast.show(err.message, 'error');
          }
        };
      });

      // Bind Upload Settlement Document
      container.querySelectorAll('[data-upload-doc]').forEach((input) => {
        input.onchange = async () => {
          const meetingId = input.getAttribute('data-upload-doc');
          const file = input.files[0];
          if (!file) return;

          try {
            await ApiClient.uploadSettlementDoc(req.id, meetingId, file);
            Toast.show('Settlement document uploaded successfully', 'success');
            BackofficeDetailController.render(container, req.id);
          } catch (err) {
            Toast.show(err.message, 'error');
          }
        };
      });

      // Bind Approve Action
      const approveBtn = container.querySelector('#approve-btn');
      if (approveBtn) {
        approveBtn.onclick = async () => {
          try {
            await ApiClient.approveRequest(req.id);
            Toast.show('Settlement request approved successfully!', 'success');
            BackofficeDetailController.render(container, req.id);
          } catch (err) {
            Toast.show(err.message, 'error');
          }
        };
      }

      // Bind Reject Action
      const rejectBtn = container.querySelector('#reject-btn');
      if (rejectBtn) {
        rejectBtn.onclick = () => {
          Modal.open({
            title: 'Reject Settlement Request',
            bodyHtml: `
              <div>
                <label class="block text-xs font-semibold text-slate-300 mb-1.5">Rejection Reason (Optional)</label>
                <textarea id="rejection-reason-input" rows="3" class="form-textarea text-xs" placeholder="Specify why this request is rejected..."></textarea>
              </div>
            `,
            footerButtons: [
              { id: 'modal-cancel', label: 'Cancel', class: 'btn-secondary text-xs' },
              {
                id: 'modal-reject-confirm',
                label: 'Confirm Rejection',
                class: 'btn-primary text-xs bg-rose-600 hover:bg-rose-500 border-rose-500',
                onClick: async (e, closeModal) => {
                  const reason = document.getElementById('rejection-reason-input').value.trim();
                  try {
                    await ApiClient.rejectRequest(req.id, reason);
                    Toast.show('Request rejected', 'info');
                    closeModal();
                    BackofficeDetailController.render(container, req.id);
                  } catch (err) {
                    Toast.show(err.message, 'error');
                  }
                },
              },
            ],
          });
        };
      }
    },
  };

  // ============================================================
  // 13. HEALTH CHECK INDICATOR
  // ============================================================
  const HealthCheck = {
    init() {
      const yearEl = document.getElementById('footer-year');
      if (yearEl) yearEl.textContent = new Date().getFullYear();

      HealthCheck.poll();
      setInterval(() => HealthCheck.poll(), CONFIG.HEALTH_POLL_INTERVAL);
    },

    async poll() {
      const dot = document.getElementById('health-dot');
      const text = document.getElementById('health-text');
      if (!dot || !text) return;

      try {
        const res = await ApiClient.checkHealth();
        if (res && res.status === 'ok') {
          dot.className = 'health-dot online';
          text.textContent = 'online';
        } else {
          dot.className = 'health-dot offline';
          text.textContent = 'degraded';
        }
      } catch (e) {
        dot.className = 'health-dot offline';
        text.textContent = 'offline';
      }
    },
  };

  // ============================================================
  // 14. APPLICATION INITIALIZATION
  // ============================================================
  document.addEventListener('DOMContentLoaded', () => {
    Router.init();
    HealthCheck.init();
  });
})();
