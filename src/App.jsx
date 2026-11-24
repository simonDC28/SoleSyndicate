import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import AiShoeScanner from './components/AiShoeScanner';
import {
  createListingInSupabase,
  deleteConversationInSupabase,
  deleteListingFromSupabase,
  fetchListingsFromSupabase,
  fetchUserAccountFromSupabase,
  fetchUserMessagesFromSupabase,
  isSupabaseConfigured,
  saveUserAccountToSupabase,
  sendMessageInSupabase,
  subscribeToListings,
  subscribeToUserMessages,
  uploadSneakerImageToSupabase,
  signInWithSupabase,
  signOutOfSupabase,
  signUpWithSupabase
} from './supabaseClient';

// =========================================================
// GOOGLE / GMAIL OAUTH 2.0 API HELPER (DYNAMIC SDK LOADER)
// =========================================================
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_CLIENT_ID =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim() ||
  '51592992726-itv7lmapugm76dgv5fn74j1jsc42spn5.apps.googleusercontent.com';

let gisLoaderPromise = null;

function loadGoogleIdentityScript() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Browser environment is required.'));
  }
  if (window.google?.accounts?.oauth2) {
    return Promise.resolve(window.google.accounts.oauth2);
  }
  if (gisLoaderPromise) {
    return gisLoaderPromise;
  }

  gisLoaderPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.google?.accounts?.oauth2) {
          resolve(window.google.accounts.oauth2);
        } else {
          gisLoaderPromise = null;
          reject(new Error('Google OAuth2 client failed to initialize.'));
        }
      });
      existing.addEventListener('error', () => {
        gisLoaderPromise = null;
        reject(new Error('Failed to load Google Identity Services SDK.'));
      });
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;

    script.onload = () => {
      if (window.google?.accounts?.oauth2) {
        resolve(window.google.accounts.oauth2);
      } else {
        gisLoaderPromise = null;
        reject(new Error('Google OAuth2 client unavailable after script load.'));
      }
    };

    script.onerror = () => {
      gisLoaderPromise = null;
      reject(
        new Error(
          'Unable to load Google Identity Services. Check your internet connection.'
        )
      );
    };

    document.head.appendChild(script);
  });

  return gisLoaderPromise;
}

async function authenticateWithGoogleApi(prompt = 'select_account') {
  const googleOAuth = await loadGoogleIdentityScript();

  return new Promise((resolve, reject) => {
    const tokenClient = googleOAuth.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'openid email profile',
      prompt,
      callback: async (tokenResponse) => {
        if (tokenResponse.error) {
          reject(
            new Error(
              tokenResponse.error_description ||
                'Google sign-in was cancelled or denied.'
            )
          );
          return;
        }

        try {
          const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
            headers: {
              Authorization: `Bearer ${tokenResponse.access_token}`
            }
          });

          if (!res.ok) {
            throw new Error('Failed to fetch Gmail profile from Google API.');
          }

          const profile = await res.json();
          resolve({
            googleSub: profile.sub,
            email: profile.email,
            emailVerified: Boolean(profile.email_verified),
            name: profile.name || profile.email.split('@')[0],
            avatar: profile.picture || '',
            accessToken: tokenResponse.access_token
          });
        } catch (err) {
          reject(err);
        }
      },
      error_callback: (err) => {
        reject(
          new Error(
            err?.message || 'Unable to open Google OAuth popup window.'
          )
        );
      }
    });

    tokenClient.requestAccessToken({ prompt });
  });
}

function signOutGoogleSession(accessToken) {
  try {
    window.google?.accounts?.id?.disableAutoSelect();
    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
      window.google.accounts.oauth2.revoke(accessToken, () => {});
    }
  } catch {
    // Ignore SDK cleanup errors
  }
}

// =========================================================
// TRANSPARENT SHOE CUTOUT & IMAGE UTILITIES
// =========================================================
const transparentShoeCache = new Map();

function TransparentShoeImg({ src, alt, className, draggable = false }) {
  const [cutoutSrc, setCutoutSrc] = useState(
    () => transparentShoeCache.get(src) || ''
  );

  useEffect(() => {
    if (!src) return;
    if (transparentShoeCache.has(src)) {
      setCutoutSrc(transparentShoeCache.get(src));
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      if (cancelled) return;
      try {
        const maxDim = 640;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);

        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        const total = w * h;

        const getRgb = (idx) => {
          const p = idx * 4;
          return [data[p], data[p + 1], data[p + 2]];
        };

        const colorDist = (a, b) =>
          Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

        const corners = [
          getRgb(2 * w + 2),
          getRgb(2 * w + (w - 3)),
          getRgb((h - 3) * w + 2),
          getRgb((h - 3) * w + (w - 3))
        ];

        const isBgCandidate = (rgb) => {
          let minD = Infinity;
          for (let c = 0; c < corners.length; c++) {
            const d = colorDist(rgb, corners[c]);
            if (d < minD) minD = d;
          }
          return minD < 64;
        };

        const bgMask = new Uint8Array(total);
        const queue = new Int32Array(total);
        let head = 0;
        let tail = 0;

        const tryEnqueue = (x, y) => {
          if (x < 0 || x >= w || y < 0 || y >= h) return;
          const idx = y * w + x;
          if (bgMask[idx]) return;
          if (isBgCandidate(getRgb(idx))) {
            bgMask[idx] = 1;
            queue[tail++] = idx;
          }
        };

        for (let x = 0; x < w; x++) {
          tryEnqueue(x, 0);
          tryEnqueue(x, h - 1);
        }
        for (let y = 0; y < h; y++) {
          tryEnqueue(0, y);
          tryEnqueue(w - 1, y);
        }

        while (head < tail) {
          const idx = queue[head++];
          const x = idx % w;
          const y = (idx / w) | 0;
          const curRgb = getRgb(idx);

          const neighbors = [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1]
          ];

          for (let n = 0; n < 4; n++) {
            const nx = neighbors[n][0];
            const ny = neighbors[n][1];
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nIdx = ny * w + nx;
            if (bgMask[nIdx]) continue;
            const nRgb = getRgb(nIdx);
            if (isBgCandidate(nRgb) && colorDist(curRgb, nRgb) < 22) {
              bgMask[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          }
        }

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            const p = idx * 4;
            if (bgMask[idx]) {
              data[p + 3] = 0;
            } else {
              let nearBg1 = false;
              let nearBg2 = false;
              for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                  const nx = x + dx;
                  const ny = y + dy;
                  if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                    if (bgMask[ny * w + nx]) {
                      const step = Math.max(Math.abs(dx), Math.abs(dy));
                      if (step === 1) nearBg1 = true;
                      else if (step === 2) nearBg2 = true;
                    }
                  }
                }
              }
              if (nearBg1) {
                data[p + 3] = 95;
              } else if (nearBg2) {
                data[p + 3] = 210;
              }
            }
          }
        }

        ctx.putImageData(imageData, 0, 0);
        const resultUrl = canvas.toDataURL('image/png');
        transparentShoeCache.set(src, resultUrl);
        if (!cancelled) setCutoutSrc(resultUrl);
      } catch {
        if (!cancelled) setCutoutSrc(src);
      }
    };

    img.onerror = () => {
      if (!cancelled) setCutoutSrc(src);
    };

    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <img
      src={cutoutSrc || src}
      alt={alt}
      className={`${className || ''} ${cutoutSrc ? 'cutout-ready' : 'cutout-loading'}`}
      draggable={draggable}
    />
  );
}

function compressImageFile(file, maxDim = 760, quality = 0.84) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(String(reader.result));
      img.src = String(reader.result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getInitials(name = 'SS') {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || '')
      .join('') || 'SS'
  );
}

function formatMessageTimestamp(isoString) {
  if (!isoString) {
    return new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  return new Date(isoString).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getProductSeller(product) {
  return (
    product.seller || {
      name: 'SoleSyndicate Concierge',
      location: 'Verified Dispatch Hub',
      avatar: '',
      bio: 'Official SoleSyndicate sneaker specialist'
    }
  );
}

function isListingOwner(product, user) {
  if (!product?.isUserListing || !user?.email || !product?.ownerEmail) {
    return false;
  }
  return (
    product.ownerEmail.trim().toLowerCase() === user.email.trim().toLowerCase()
  );
}

function buildThreadKey(listingId, buyerEmail) {
  return `${String(listingId)}::${buyerEmail.trim().toLowerCase()}`;
}

function groupMessageRowsIntoThreads(rows) {
  const map = {};
  (rows || []).forEach((row) => {
    const key = buildThreadKey(row.listing_id, row.buyer_email);
    if (!map[key]) {
      map[key] = {
        threadKey: key,
        listingId: String(row.listing_id),
        listingName: row.listing_name,
        listingImage: row.listing_image || '',
        listingPrice: Number(row.listing_price || 0),
        sellerEmail: row.seller_email.trim().toLowerCase(),
        sellerName: row.seller_name,
        buyerEmail: row.buyer_email.trim().toLowerCase(),
        buyerName: row.buyer_name,
        buyerUserId: row.buyer_user_id || null,
        sellerUserId: row.seller_user_id || null,
        messages: []
      };
    }
    map[key].messages.push({
      id: row.id,
      senderEmail: row.sender_email.trim().toLowerCase(),
      senderName: row.sender_name,
      text: row.message_text,
      time: formatMessageTimestamp(row.created_at),
      createdAt: row.created_at
    });
  });
  return map;
}

// =========================================================
// GMAIL / GOOGLE API LOGIN & REGISTRATION MODAL
// =========================================================
function GoogleGIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
      />
    </svg>
  );
}

function AuthModal({
  initialMode = 'login',
  registeredUsers,
  onClose,
  onCompleteAuth
}) {
  const [mode, setMode] = useState(initialMode);
  const [isLoadingGoogle, setIsLoadingGoogle] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [location, setLocation] = useState('');
  const [role, setRole] = useState('Buyer & Seller');

  const [pendingGoogleProfile, setPendingGoogleProfile] = useState(null);
  const [onboardName, setOnboardName] = useState('');
  const [onboardLocation, setOnboardLocation] = useState('');
  const [onboardBio, setOnboardBio] = useState('');

  const handleGoogleOAuthClick = async () => {
    setError('');
    setIsLoadingGoogle(true);
    try {
      const googleUser = await authenticateWithGoogleApi(
        mode === 'register' ? 'consent select_account' : 'select_account'
      );

      const cleanEmail = googleUser.email.trim().toLowerCase();
      const localMatch = registeredUsers.find(
        (u) =>
          u.email.toLowerCase() === cleanEmail ||
          (u.googleSub && u.googleSub === googleUser.googleSub)
      );
      const cloudMatch = isSupabaseConfigured
        ? await fetchUserAccountFromSupabase(cleanEmail)
        : null;

      const existing = cloudMatch
        ? {
            id: `user_${cleanEmail}`,
            googleSub: cloudMatch.google_sub || googleUser.googleSub,
            authProvider: 'google',
            emailVerified: true,
            name: cloudMatch.name || googleUser.name,
            email: cleanEmail,
            location: cloudMatch.location || '',
            role: cloudMatch.role || 'Buyer & Seller',
            avatar: googleUser.avatar || cloudMatch.avatar || '',
            bio: cloudMatch.bio || '',
            savedState: {
              favorites: cloudMatch.favorites || [],
              cart: cloudMatch.cart || [],
              orders: cloudMatch.orders || []
            }
          }
        : localMatch;

      if (existing) {
        await onCompleteAuth(
          {
            ...existing,
            avatar: googleUser.avatar || existing.avatar,
            googleSub: googleUser.googleSub,
            authProvider: 'google',
            emailVerified: true,
            accessToken: googleUser.accessToken
          },
          false
        );
      } else {
        setPendingGoogleProfile(googleUser);
        setOnboardName(googleUser.name || '');
        setOnboardLocation('');
        setOnboardBio('Verified Gmail member • SoleSyndicate community');
        setMode('google-onboard');
      }
    } catch (err) {
      setError(err.message || 'Google authentication failed.');
    } finally {
      setIsLoadingGoogle(false);
    }
  };

  const handleFinishGoogleRegistration = async (e) => {
    e.preventDefault();
    if (!pendingGoogleProfile) return;
    if (!onboardName.trim() || !onboardLocation.trim()) {
      setError('Please enter your display name and city/location.');
      return;
    }

    setIsSubmitting(true);
    await onCompleteAuth(
      {
        id: `user_${Date.now()}`,
        googleSub: pendingGoogleProfile.googleSub,
        authProvider: 'google',
        emailVerified: pendingGoogleProfile.emailVerified,
        name: onboardName.trim(),
        email: pendingGoogleProfile.email.trim().toLowerCase(),
        location: onboardLocation.trim(),
        role: 'Buyer & Seller',
        avatar: pendingGoogleProfile.avatar || '',
        bio:
          onboardBio.trim() ||
          'Verified Gmail member • SoleSyndicate community',
        accessToken: pendingGoogleProfile.accessToken,
        createdAt: new Date().toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        })
      },
      true
    );
    setIsSubmitting(false);
  };

  const handleManualLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const cleanEmail = email.trim().toLowerCase();
      if (isSupabaseConfigured) {
        const authData = await signInWithSupabase(cleanEmail, password);
        const authUser = authData?.user;
        const cloudProfile = await fetchUserAccountFromSupabase(cleanEmail);
        await onCompleteAuth(
          {
            id: authUser?.id || `user_${cleanEmail}`,
            googleSub: cloudProfile?.google_sub,
            authProvider: 'gmail-form',
            emailVerified: Boolean(authUser?.email_confirmed_at),
            name: cloudProfile?.name || authUser?.user_metadata?.name || cleanEmail.split('@')[0],
            email: cleanEmail,
            location: cloudProfile?.location || '',
            role: cloudProfile?.role || 'Buyer & Seller',
            avatar: cloudProfile?.avatar || '',
            bio: cloudProfile?.bio || '',
            savedState: {
              favorites: cloudProfile?.favorites || [],
              cart: cloudProfile?.cart || [],
              orders: cloudProfile?.orders || []
            }
          },
          false
        );
        return;
      }

      let matched = registeredUsers.find(
        (u) => u.email.toLowerCase() === cleanEmail
      );

      if (!matched && isSupabaseConfigured) {
        const cloudProfile = await fetchUserAccountFromSupabase(cleanEmail);
        if (cloudProfile) {
          matched = {
            id: `user_${cleanEmail}`,
            googleSub: cloudProfile.google_sub,
            authProvider: cloudProfile.auth_provider || 'gmail-form',
            emailVerified: Boolean(cloudProfile.email_verified),
            name: cloudProfile.name,
            email: cleanEmail,
            password: cloudProfile.password,
            location: cloudProfile.location || '',
            role: cloudProfile.role || 'Buyer & Seller',
            avatar: cloudProfile.avatar || '',
            bio: cloudProfile.bio || '',
            savedState: {
              favorites: cloudProfile.favorites || [],
              cart: cloudProfile.cart || [],
              orders: cloudProfile.orders || []
            }
          };
        }
      }

      if (!matched) {
        setError(
          'No account found for that Gmail address. Switch to Register or continue with Google.'
        );
        return;
      }
      if (matched.authProvider === 'google' && !matched.password) {
        setError(
          'This Gmail account uses Google Sign-In. Click "Continue with Google (Gmail API)" above.'
        );
        return;
      }
      if (matched.password !== password) {
        setError('Incorrect password. Please try again.');
        return;
      }

      await onCompleteAuth(matched, false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleManualRegister = async (e) => {
    e.preventDefault();
    setError('');
    const cleanName = fullName.trim();
    const cleanEmail = email.trim().toLowerCase();
    const cleanLocation = location.trim();

    if (!cleanName || !cleanEmail || !cleanLocation) {
      setError('Please complete your name, Gmail address, and location.');
      return;
    }
    if (!cleanEmail.endsWith('@gmail.com')) {
      setError('Please enter a valid @gmail.com address.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (isSupabaseConfigured) {
        const authData = await signUpWithSupabase({
          email: cleanEmail,
          password,
          name: cleanName,
          location: cleanLocation,
          role
        });
        const authUser = authData?.user;
        if (!authUser || !authData.session) {
          setError(
            authUser
              ? 'Account created. Check your email to confirm it, then sign in.'
              : 'Unable to create your account. Please try again.'
          );
          return;
        }

        await onCompleteAuth(
          {
            id: authUser.id,
            authProvider: 'gmail-form',
            emailVerified: Boolean(authUser.email_confirmed_at),
            name: cleanName,
            email: cleanEmail,
            location: cleanLocation,
            role,
            avatar: '',
            bio: `${role} • ${cleanLocation}`,
            createdAt: new Date().toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric'
            })
          },
          true
        );
        return;
      }

      const existsLocally = registeredUsers.some(
        (u) => u.email.toLowerCase() === cleanEmail
      );
      const existsInCloud = isSupabaseConfigured
        ? Boolean(await fetchUserAccountFromSupabase(cleanEmail))
        : false;

      if (existsLocally || existsInCloud) {
        setError('An account with this Gmail already exists. Please Log In.');
        return;
      }

      await onCompleteAuth(
        {
          id: `user_${Date.now()}`,
          authProvider: 'gmail-form',
          emailVerified: false,
          name: cleanName,
          email: cleanEmail,
          password,
          location: cleanLocation,
          role,
          avatar: '',
          bio: `${role} • ${cleanLocation}`,
          createdAt: new Date().toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          })
        },
        true
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="qv-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="SoleSyndicate Account Authentication"
    >
      <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="qv-close"
          aria-label="Close authentication modal"
          onClick={onClose}
        >
          ✕
        </button>

        <div className="auth-brand-top">
          <div className="auth-brand-mark">
            SoleSyndicate<span>.</span>
          </div>
          <span className="auth-api-pill">● Google OAuth API Ready</span>
        </div>

        {mode !== 'google-onboard' && (
          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`auth-tab-btn ${mode === 'login' ? 'active' : ''}`}
              onClick={() => {
                setMode('login');
                setError('');
              }}
            >
              Log In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={`auth-tab-btn ${mode === 'register' ? 'active' : ''}`}
              onClick={() => {
                setMode('register');
                setError('');
              }}
            >
              Register
            </button>
          </div>
        )}

        {mode === 'google-onboard' && pendingGoogleProfile ? (
          <>
            <h2 className="auth-heading">Complete Gmail Registration</h2>
            <p className="auth-subcopy">
              Your Gmail identity was verified via Google API. Confirm your
              member profile to start buying and listing sneakers.
            </p>

            <div className="google-onboard-card">
              {pendingGoogleProfile.avatar ? (
                <img
                  src={pendingGoogleProfile.avatar}
                  alt={pendingGoogleProfile.name}
                />
              ) : (
                <div className="seller-mini-initials">
                  {getInitials(pendingGoogleProfile.name)}
                </div>
              )}
              <div>
                <span className="google-onboard-badge">
                  ✓ VERIFIED GMAIL ACCOUNT
                </span>
                <div className="google-onboard-email">
                  {pendingGoogleProfile.email}
                </div>
              </div>
            </div>

            {error && (
              <div className="auth-error-banner" style={{ marginBottom: 12 }}>
                {error}
              </div>
            )}

            <form
              className="auth-form"
              onSubmit={handleFinishGoogleRegistration}
            >
              <div className="auth-field">
                <label htmlFor="onboard-name">DISPLAY NAME *</label>
                <input
                  id="onboard-name"
                  type="text"
                  required
                  value={onboardName}
                  onChange={(e) => setOnboardName(e.target.value)}
                />
              </div>

              <div className="auth-field">
                <label htmlFor="onboard-location">CITY / LOCATION *</label>
                <input
                  id="onboard-location"
                  type="text"
                  required
                  value={onboardLocation}
                  onChange={(e) => setOnboardLocation(e.target.value)}
                  placeholder="e.g. Digos City, Davao Region"
                />
              </div>

              <div className="auth-field">
                <label htmlFor="onboard-bio">MEMBER / SELLER BIO</label>
                <textarea
                  id="onboard-bio"
                  rows={2}
                  value={onboardBio}
                  onChange={(e) => setOnboardBio(e.target.value)}
                />
              </div>

              <button
                type="submit"
                className="auth-submit-btn"
                disabled={isSubmitting}
              >
                {isSubmitting
                  ? 'Creating Account...'
                  : 'Finish Registration & Enter Storefront →'}
              </button>
            </form>
          </>
        ) : (
          <>
            <h2 className="auth-heading">
              {mode === 'login'
                ? 'Welcome Back to SoleSyndicate'
                : 'Create Your SoleSyndicate Account'}
            </h2>
            <p className="auth-subcopy">
              {mode === 'login'
                ? 'Log in to restore your saved wishlist, bag, listings, and messages.'
                : 'Register a new account with a clean slate—all progress saves automatically.'}
            </p>

            <button
              type="button"
              className="google-oauth-btn"
              disabled={isLoadingGoogle}
              onClick={handleGoogleOAuthClick}
            >
              <GoogleGIcon />
              <span>
                {isLoadingGoogle
                  ? 'Connecting to Google API...'
                  : mode === 'login'
                  ? 'Continue with Google (Gmail API)'
                  : 'Register with Google (Gmail API)'}
              </span>
            </button>

            <div className="auth-divider">
              <span>
                {mode === 'login'
                  ? 'OR LOG IN WITH GMAIL & PASSWORD'
                  : 'OR REGISTER WITH GMAIL FORM'}
              </span>
            </div>

            {error && (
              <div className="auth-error-banner" style={{ marginBottom: 12 }}>
                {error}
              </div>
            )}

            {mode === 'login' ? (
              <form className="auth-form" onSubmit={handleManualLogin}>
                <div className="auth-field">
                  <label htmlFor="login-email">GMAIL ADDRESS *</label>
                  <input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                  />
                </div>

                <div className="auth-field">
                  <label htmlFor="login-password">PASSWORD *</label>
                  <input
                    id="login-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>

                <button
                  type="submit"
                  className="auth-submit-btn"
                  disabled={isSubmitting}
                >
                  {isSubmitting
                    ? 'Loading Your Account...'
                    : 'Log In to SoleSyndicate →'}
                </button>
              </form>
            ) : (
              <form className="auth-form" onSubmit={handleManualRegister}>
                <div className="auth-field">
                  <label htmlFor="reg-name">FULL NAME *</label>
                  <input
                    id="reg-name"
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Simon Cruz"
                  />
                </div>

                <div className="auth-field">
                  <label htmlFor="reg-email">GMAIL ADDRESS *</label>
                  <input
                    id="reg-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                  />
                </div>

                <div className="sell-row-2">
                  <div className="auth-field">
                    <label htmlFor="reg-location">CITY / LOCATION *</label>
                    <input
                      id="reg-location"
                      type="text"
                      required
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="Digos City, Davao"
                    />
                  </div>

                  <div className="auth-field">
                    <label htmlFor="reg-role">ACCOUNT ROLE</label>
                    <select
                      id="reg-role"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                    >
                      <option value="Buyer & Seller">Buyer &amp; Seller</option>
                      <option value="Sneaker Buyer">Sneaker Buyer</option>
                    </select>
                  </div>
                </div>

                <div className="auth-field">
                  <label htmlFor="reg-password">CREATE PASSWORD *</label>
                  <input
                    id="reg-password"
                    type="password"
                    minLength={6}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 6 characters"
                  />
                </div>

                <button
                  type="submit"
                  className="auth-submit-btn"
                  disabled={isSubmitting}
                >
                  {isSubmitting
                    ? 'Creating Fresh Account...'
                    : 'Create Account with Gmail →'}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AccountHubModal({
  user,
  userListings,
  orders,
  favoritesCount,
  onClose,
  onUpdateProfile,
  onDeleteListing,
  onOpenSellModal,
  onSignOut
}) {
  const [activeTab, setActiveTab] = useState('profile');
  const [nameDraft, setNameDraft] = useState(user.name || '');
  const [locationDraft, setLocationDraft] = useState(user.location || '');
  const [bioDraft, setBioDraft] = useState(user.bio || '');
  const [savedNotice, setSavedNotice] = useState(false);

  const handleSaveProfile = (e) => {
    e.preventDefault();
    onUpdateProfile({
      ...user,
      name: nameDraft.trim() || user.name,
      location: locationDraft.trim() || user.location,
      bio: bioDraft.trim()
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 3000);
  };

  return (
    <div
      className="qv-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Member Account Hub"
    >
      <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="qv-close"
          aria-label="Close account hub"
          onClick={onClose}
        >
          ✕
        </button>

        <div className="profile-banner-card">
          <div className="profile-banner-avatar">
            {user.avatar ? (
              <img src={user.avatar} alt={user.name} />
            ) : (
              <span>{getInitials(user.name)}</span>
            )}
          </div>

          <div className="profile-banner-info">
            <div className="profile-banner-name-row">
              <h2>{user.name}</h2>
              {user.emailVerified && (
                <span className="qv-verified-seller-pill">
                  ✓ GOOGLE API VERIFIED
                </span>
              )}
            </div>
            <div className="profile-banner-meta">
              <span>✉ {user.email}</span>
              {user.location && <span>• 📍 {user.location}</span>}
            </div>
            {user.bio && <p className="profile-banner-bio">{user.bio}</p>}
          </div>

          <div className="profile-stats-row">
            <div className="profile-stat-box">
              <strong>{favoritesCount}</strong>
              <span>Saved</span>
            </div>
            <div className="profile-stat-box">
              <strong>{userListings.length}</strong>
              <span>Listings</span>
            </div>
            <div className="profile-stat-box">
              <strong>{orders.length}</strong>
              <span>Orders</span>
            </div>
          </div>
        </div>

        <div className="profile-tabs">
          <button
            type="button"
            className={`profile-tab-btn ${
              activeTab === 'profile' ? 'active' : ''
            }`}
            onClick={() => setActiveTab('profile')}
          >
            Account &amp; Profile
          </button>
          <button
            type="button"
            className={`profile-tab-btn ${
              activeTab === 'listings' ? 'active' : ''
            }`}
            onClick={() => setActiveTab('listings')}
          >
            My Listings ({userListings.length})
          </button>
          <button
            type="button"
            className={`profile-tab-btn ${
              activeTab === 'orders' ? 'active' : ''
            }`}
            onClick={() => setActiveTab('orders')}
          >
            Order History ({orders.length})
          </button>
        </div>

        <div className="profile-tab-panel">
          {activeTab === 'profile' && (
            <form className="profile-edit-form" onSubmit={handleSaveProfile}>
              {savedNotice && (
                <div className="profile-saved-toast">
                  ✓ Profile updated and saved to your account!
                </div>
              )}

              <div className="sell-row-2">
                <div className="auth-field">
                  <label htmlFor="hub-name">DISPLAY NAME</label>
                  <input
                    id="hub-name"
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                  />
                </div>
                <div className="auth-field">
                  <label htmlFor="hub-location">CITY / LOCATION</label>
                  <input
                    id="hub-location"
                    type="text"
                    value={locationDraft}
                    onChange={(e) => setLocationDraft(e.target.value)}
                  />
                </div>
              </div>

              <div className="auth-field">
                <label htmlFor="hub-bio">BIO / MEETUP PREFERENCES</label>
                <textarea
                  id="hub-bio"
                  rows={2}
                  value={bioDraft}
                  onChange={(e) => setBioDraft(e.target.value)}
                />
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 10,
                  marginTop: 6
                }}
              >
                <button
                  type="button"
                  className="account-signout-btn"
                  onClick={onSignOut}
                >
                  Save &amp; Sign Out
                </button>
                <button type="submit" className="sell-submit-btn">
                  Save Profile Changes
                </button>
              </div>
            </form>
          )}

          {activeTab === 'listings' && (
            <>
              {userListings.length === 0 ? (
                <div className="profile-empty-box">
                  <p>You haven&apos;t listed any sneakers yet.</p>
                  <button
                    type="button"
                    className="sell-submit-btn"
                    onClick={() => {
                      onClose();
                      onOpenSellModal();
                    }}
                  >
                    + List Your First Pair
                  </button>
                </div>
              ) : (
                <div className="profile-items-list">
                  {userListings.map((item) => (
                    <div key={item.id} className="profile-list-card">
                      <img src={item.image} alt={item.name} />
                      <div className="profile-list-info">
                        <span className="brand-pill">{item.brand}</span>
                        <h4>{item.name}</h4>
                        <p>
                          ${item.price} • Sizes: {(item.options || []).join(', ')}
                        </p>
                      </div>
                      <div className="profile-list-actions">
                        <button
                          type="button"
                          className="account-signout-btn"
                          onClick={() => onDeleteListing(item.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {activeTab === 'orders' && (
            <>
              {orders.length === 0 ? (
                <div className="profile-empty-box">
                  <p>No orders placed under {user.email} yet.</p>
                </div>
              ) : (
                <div className="profile-items-list">
                  {orders.map((order) => (
                    <div key={order.id} className="profile-order-card">
                      <div className="profile-order-top">
                        <strong>Order #{order.id}</strong>
                        <strong>${order.total}</strong>
                      </div>
                      <div className="profile-order-meta">
                        <span>{order.date}</span>
                        <span>• Delivered to {user.email}</span>
                      </div>
                      <div className="profile-order-items">
                        {order.items.map((it, i) => (
                          <span key={i} className="profile-order-chip">
                            {it.qty}× {it.name} ({it.selectedOption})
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// =========================================================
// STOREFRONT CATALOG & DATA
// =========================================================
const HERO_SHOE_SLIDES = [
  {
    id: 'nike-crimson',
    brandTag: 'NIKE',
    colorName: 'Crimson Red',
    cardTitle: 'Nike Air Max Crimson',
    swatch: '#dc2626',
    accent: '#dc2626',
    bannerBg:
      'radial-gradient(circle at 52% 48%, #fecaca 0%, #f87171 38%, #dc2626 100%)',
    cardGradient:
      'linear-gradient(165deg, #ff7a7a 0%, #ef4444 58%, #dc2626 100%)',
    cardFooterBg: '#b91c1c',
    isLightHero: false,
    headline: 'Step-up Your Stride',
    subcopy: 'Nike Air Max 1 • Crimson Red Edition',
    heroShoeImage:
      'https://images.unsplash.com/photo-1600185365926-3a2ce3cdb9eb?auto=format&fit=crop&w=900&q=90',
    featuredShoe: {
      id: 101,
      brand: 'NIKE',
      name: 'NIKE AIR MAX 1 CRIMSON',
      subtitle: 'Visible Air Cushioning Runner',
      description:
        'Iconic visible heel Air unit paired with breathable white mesh and vibrant crimson-orange suede overlays.',
      specs: [
        'Breathable engineered mesh & suede upper',
        'Visible Max Air heel cushioning unit',
        'Waffle-pattern rubber traction outsole',
        'Padded low-cut collar for daily comfort'
      ],
      price: 140,
      originalPrice: 160,
      optionLabel: 'SELECT SIZE',
      options: ['US 8', 'US 9', 'US 10', 'US 11'],
      category: 'Performance Series',
      image:
        'https://images.unsplash.com/photo-1600185365926-3a2ce3cdb9eb?auto=format&fit=crop&w=800&q=85'
    }
  },
  {
    id: 'nike-cobalt',
    brandTag: 'NIKE',
    colorName: 'Cobalt Blue',
    cardTitle: 'Nike Air Max Cobalt',
    swatch: '#2563eb',
    accent: '#2563eb',
    bannerBg:
      'radial-gradient(circle at 52% 48%, #bfdbfe 0%, #60a5fa 38%, #1d4ed8 100%)',
    cardGradient:
      'linear-gradient(165deg, #56ccf2 0%, #2f80ed 60%, #1d4ed8 100%)',
    cardFooterBg: '#1e40af',
    isLightHero: false,
    headline: 'Step-up Your Stride',
    subcopy: 'Nike Air Max 90 • Cobalt Blue Edition',
    heroShoeImage:
      'https://images.unsplash.com/photo-1515955656352-a1fa3ffcd111?auto=format&fit=crop&w=900&q=90',
    featuredShoe: {
      id: 102,
      brand: 'NIKE',
      name: 'NIKE AIR MAX COBALT',
      subtitle: 'All-Day Street Cushion Trainer',
      description:
        'Monochrome cobalt blue upper with sculpted foam midsole and responsive Air window for effortless urban strides.',
      specs: [
        'Layered synthetic & breathable textile upper',
        'Dual-density foam + Air heel unit',
        'Flex grooves for natural foot motion',
        'Reinforced high-wear rubber outsole'
      ],
      price: 135,
      originalPrice: 160,
      optionLabel: 'SELECT SIZE',
      options: ['US 8', 'US 9', 'US 10', 'US 11'],
      category: 'Performance Series',
      image:
        'https://images.unsplash.com/photo-1515955656352-a1fa3ffcd111?auto=format&fit=crop&w=800&q=85'
    }
  },
  {
    id: 'adidas-solar',
    brandTag: 'ADIDAS',
    colorName: 'Solar Yellow',
    cardTitle: 'Adidas Gazelle Solar',
    swatch: '#eab308',
    accent: '#b45309',
    bannerBg:
      'radial-gradient(circle at 52% 48%, #fef9c3 0%, #fde047 42%, #eab308 100%)',
    cardGradient:
      'linear-gradient(165deg, #fef08a 0%, #facc15 60%, #eab308 100%)',
    cardFooterBg: '#a16207',
    isLightHero: true,
    headline: 'Step-up Your Stride',
    subcopy: 'Adidas Originals • Solar Yellow Edition',
    heroShoeImage:
      'https://images.unsplash.com/photo-1525966222134-fcfa99b8ae77?auto=format&fit=crop&w=900&q=90',
    featuredShoe: {
      id: 103,
      brand: 'ADIDAS',
      name: 'ADIDAS ORIGINALS SOLAR LOW',
      subtitle: 'Heritage Terrace Skate & Street Shoe',
      description:
        'Sunburst yellow suede and canvas construction finished with vulcanized rubber foxing and cloud-soft OrthoLite insole.',
      specs: [
        'Premium solar-dyed suede & canvas upper',
        'OrthoLite cushioned performance sockliner',
        'High-grip vulcanized gum rubber outsole',
        'Classic serrated 3-Stripes detailing'
      ],
      price: 120,
      originalPrice: 145,
      optionLabel: 'SELECT SIZE',
      options: ['US 8', 'US 9', 'US 10', 'US 11'],
      category: 'Limited Edition',
      image:
        'https://images.unsplash.com/photo-1525966222134-fcfa99b8ae77?auto=format&fit=crop&w=800&q=85'
    }
  },
  {
    id: 'adidas-obsidian',
    brandTag: 'ADIDAS',
    colorName: 'Obsidian Black',
    cardTitle: 'Adidas Ultraboost',
    swatch: '#18181b',
    accent: '#18181b',
    bannerBg:
      'radial-gradient(circle at 52% 48%, #d4d4d8 0%, #52525b 42%, #09090b 100%)',
    cardGradient:
      'linear-gradient(165deg, #9ca3af 0%, #52525b 58%, #27272a 100%)',
    cardFooterBg: '#09090b',
    isLightHero: false,
    headline: 'Step-up Your Stride',
    subcopy: 'Adidas Ultraboost Light • Obsidian Black',
    heroShoeImage:
      'https://images.unsplash.com/photo-1491553895911-0055eca6402d?auto=format&fit=crop&w=900&q=90',
    featuredShoe: {
      id: 104,
      brand: 'ADIDAS',
      name: 'ADIDAS ULTRABOOST OBSIDIAN',
      subtitle: 'High-Energy Return Road Runner',
      description:
        'Sock-like Primeknit upper paired with responsive Boost midsole capsules and Continental rubber wet/dry grip.',
      specs: [
        'Adaptive Primeknit+ forged upper',
        'Lightweight BOOST energy-return midsole',
        'Linear Energy Push torsion system',
        'Continental Rubber all-weather outsole'
      ],
      price: 165,
      originalPrice: 190,
      optionLabel: 'SELECT SIZE',
      options: ['US 8', 'US 9', 'US 10', 'US 11'],
      category: 'Performance Series',
      image:
        'https://images.unsplash.com/photo-1491553895911-0055eca6402d?auto=format&fit=crop&w=800&q=85'
    }
  },
  {
    id: 'oncloud-emerald',
    brandTag: 'ON CLOUD',
    colorName: 'Emerald Green',
    cardTitle: 'On Cloudmonster',
    swatch: '#16a34a',
    accent: '#15803d',
    bannerBg:
      'radial-gradient(circle at 52% 48%, #dcfce7 0%, #4ade80 38%, #15803d 100%)',
    cardGradient:
      'linear-gradient(165deg, #a3e635 0%, #22c55e 58%, #15803d 100%)',
    cardFooterBg: '#14532d',
    isLightHero: false,
    headline: 'Step-up Your Stride',
    subcopy: 'On Cloudmonster • Emerald Volt Edition',
    heroShoeImage:
      'https://images.unsplash.com/photo-1606107557195-0e29a4b5b4aa?auto=format&fit=crop&w=900&q=90',
    featuredShoe: {
      id: 105,
      brand: 'ON CLOUD',
      name: 'ON CLOUDMONSTER EMERALD',
      subtitle: 'Max-Cushioned CloudTec Road Runner',
      description:
        'Swiss-engineered oversized CloudTec pods and explosive Speedboard propulsion for effortless long-distance bounce.',
      specs: [
        'Max-cushioned Helion superfoam CloudTec',
        'Snappy polypropylene Speedboard',
        'Recycled breathable engineered mesh',
        '6mm heel-to-toe rocker geometry'
      ],
      price: 170,
      originalPrice: 195,
      optionLabel: 'SELECT SIZE',
      options: ['US 8', 'US 9', 'US 10', 'US 11'],
      category: 'Performance Series',
      image:
        'https://images.unsplash.com/photo-1606107557195-0e29a4b5b4aa?auto=format&fit=crop&w=800&q=85'
    }
  },
  {
    id: 'oncloud-pink',
    brandTag: 'ON CLOUD',
    colorName: 'Rose Pink',
    cardTitle: 'On Cloudnova Pink',
    swatch: '#ec4899',
    accent: '#db2777',
    bannerBg:
      'radial-gradient(circle at 52% 48%, #fce7f3 0%, #f472b6 40%, #be185d 100%)',
    cardGradient:
      'linear-gradient(165deg, #f9a8d4 0%, #ec4899 58%, #be185d 100%)',
    cardFooterBg: '#831843',
    isLightHero: false,
    headline: 'Step-up Your Stride',
    subcopy: 'On Cloudnova Form • Rose Pink Edition',
    heroShoeImage:
      'https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=900&q=90',
    featuredShoe: {
      id: 106,
      brand: 'ON CLOUD',
      name: 'ON CLOUDNOVA ROSE PINK',
      subtitle: 'Lightweight CloudTec All-Day Sneaker',
      description:
        'Blush rose knit upper meets zero-gravity CloudTec cushioning and a supportive heel clip for all-day city movement.',
      specs: [
        'Ultra-lightweight recycled polyester mesh',
        'Zero-Gravity foam CloudTec pods',
        'Custom Speedboard for smooth roll-through',
        'Plush microfiber tongue & heel collar'
      ],
      price: 155,
      originalPrice: 180,
      optionLabel: 'SELECT SIZE',
      options: ['US 6', 'US 7', 'US 8', 'US 9', 'US 10'],
      category: 'Limited Edition',
      image:
        'https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=800&q=85'
    }
  }
];

function shuffleSlides(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const BEST_SELLERS = [
  {
    id: 1,
    brand: 'NIKE',
    name: 'NIKE AIR MAX 1 CRIMSON',
    subtitle: 'Visible Air unit & breathable white mesh',
    description:
      'Iconic visible heel Air cushioning paired with crisp white mesh and vibrant crimson-orange suede overlays.',
    specs: [
      'Breathable engineered mesh & suede upper',
      'Visible Max Air heel cushioning unit',
      'Waffle-pattern rubber traction outsole',
      'Padded low-cut collar'
    ],
    optionLabel: 'SELECT SIZE',
    options: ['US 7', 'US 8', 'US 9', 'US 10', 'US 11'],
    price: 140,
    badge: 'BEST SELLER',
    rating: 4.9,
    reviews: 342,
    category: 'Performance Series',
    image:
      'https://images.unsplash.com/photo-1600185365926-3a2ce3cdb9eb?auto=format&fit=crop&w=800&q=85',
    seller: {
      name: 'Marcus Vance',
      location: 'Manila, Metro Manila',
      bio: 'Verified Air Max collector • Same-day courier or local meetup'
    }
  },
  {
    id: 2,
    brand: 'ON CLOUD',
    name: 'ON CLOUDNOVA ROSE PINK',
    subtitle: 'Zero-gravity CloudTec cushioning in Rose Pink',
    description:
      'Swiss-engineered CloudTec pods meet a soft rose-pink recycled mesh upper for featherlight all-day comfort.',
    specs: [
      'Zero-Gravity foam CloudTec outsole',
      '40% recycled breathable mesh upper',
      'Integrated Speedboard energy return',
      'Weight: 232g'
    ],
    optionLabel: 'SELECT SIZE',
    options: ['US 6', 'US 7', 'US 8', 'US 9', 'US 10'],
    price: 155,
    originalPrice: 180,
    discountTag: 'SALE',
    badge: 'SALE',
    rating: 4.9,
    reviews: 289,
    category: 'Limited Edition',
    image:
      'https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=800&q=85',
    seller: {
      name: 'Elena Rostova',
      location: 'Cebu City, Central Visayas',
      bio: 'Running & lifestyle footwear specialist • Original box included'
    }
  },
  {
    id: 3,
    brand: 'ADIDAS',
    name: 'ADIDAS FORUM LOW TRIPLE WHITE',
    subtitle: 'Crisp full-grain leather court classic',
    description:
      'Clean monochrome white leather silhouette with perforated toe box, cushioned EVA midsole, and heritage court grip.',
    specs: [
      'Supple coated leather upper',
      'Breathable perforated forefoot',
      'Cushioned EVA drop-in midsole',
      'Non-marking rubber cup-sole'
    ],
    optionLabel: 'SELECT SIZE',
    options: ['US 7', 'US 8', 'US 9', 'US 10', 'US 11'],
    price: 115,
    badge: 'BEST SELLER',
    rating: 4.8,
    reviews: 264,
    category: 'Limited Edition',
    image:
      'https://images.unsplash.com/photo-1608231387042-66d1773070a5?auto=format&fit=crop&w=800&q=85',
    seller: {
      name: 'Devon Brooks',
      location: 'Davao City, Davao Region',
      bio: 'Classic court & terrace sneaker curator • Fast response'
    }
  },
  {
    id: 4,
    brand: 'NIKE',
    name: 'NIKE AIR FORCE 1 PASTEL KIDS',
    subtitle: 'Soft pastel colorblock leather for youth',
    description:
      'Layered pastel pink, sky blue, and buttercream leather panels over classic Nike Air cushioning for active kids.',
    specs: [
      'Durable stitched leather overlays',
      'Encapsulated Nike Air heel cushioning',
      'Padded ankle collar & tongue',
      'Pivot-circle rubber traction sole'
    ],
    optionLabel: 'SELECT YOUTH SIZE',
    options: ['US 1Y', 'US 2Y', 'US 3Y', 'US 4Y', 'US 5Y'],
    price: 76,
    originalPrice: 95,
    discountTag: 'SALE',
    badge: 'SALE',
    rating: 4.9,
    reviews: 198,
    category: 'Kids Collection',
    image:
      'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=800&q=85',
    seller: {
      name: 'Claire Lin',
      location: 'Makati, Metro Manila',
      bio: 'Youth & family sneaker boutique • 100% deadstock pairs'
    }
  }
];

const EXTRA_CATALOG_PRODUCTS = [
  {
    id: 5,
    brand: 'ON CLOUD',
    name: 'ON CLOUDMONSTER EMERALD',
    subtitle: 'Max-cushioned Helion superfoam runner',
    description:
      'Our biggest CloudTec pods ever combine with an explosive Speedboard for monster bounce on daily road runs.',
    specs: [
      'Oversized Helion superfoam CloudTec',
      'Snappy polypropylene Speedboard',
      'Recycled engineered mesh upper',
      '6mm heel-to-toe drop'
    ],
    optionLabel: 'SELECT SIZE',
    options: ['US 8', 'US 9', 'US 10', 'US 11'],
    price: 170,
    originalPrice: 195,
    discountTag: '-13% OFF',
    badge: 'SALE',
    rating: 4.9,
    reviews: 310,
    category: 'Performance Series',
    image:
      'https://images.unsplash.com/photo-1606107557195-0e29a4b5b4aa?auto=format&fit=crop&w=800&q=85',
    seller: {
      name: 'Elena Rostova',
      location: 'Cebu City, Central Visayas',
      bio: 'Running & lifestyle footwear specialist • Original box included'
    }
  },
  {
    id: 6,
    brand: 'ADIDAS',
    name: 'ADIDAS ULTRABOOST OBSIDIAN',
    subtitle: 'Primeknit+ upper with responsive BOOST',
    description:
      'Engineered with hundreds of fused BOOST capsules and a sock-like Primeknit+ upper for endless energy return.',
    specs: [
      'Adaptive Primeknit+ textile upper',
      'High-rebound BOOST midsole',
      'Linear Energy Push midfoot system',
      'Continental Rubber wet/dry outsole'
    ],
    optionLabel: 'SELECT SIZE',
    options: ['US 8', 'US 9', 'US 10', 'US 11', 'US 12'],
    price: 165,
    badge: 'TOP RATED',
    rating: 4.9,
    reviews: 278,
    category: 'Performance Series',
    image:
      'https://images.unsplash.com/photo-1491553895911-0055eca6402d?auto=format&fit=crop&w=800&q=85',
    seller: {
      name: 'Devon Brooks',
      location: 'Davao City, Davao Region',
      bio: 'Classic court & terrace sneaker curator • Fast response'
    }
  },
  {
    id: 7,
    brand: 'NIKE',
    name: 'NIKE REVOLUTION KIDS CRIMSON',
    subtitle: '20% off lightweight everyday youth runner',
    description:
      'Plush foam midsole, breathable crimson mesh, and flexible outsole grooves built for all-day school and play.',
    specs: [
      'Lightweight breathable crimson knit',
      'Soft foam underfoot cushioning',
      'Reinforced toe tip for durability',
      'Flexible traction outsole'
    ],
    optionLabel: 'SELECT YOUTH SIZE',
    options: ['US 1Y', 'US 2Y', 'US 3Y', 'US 4Y'],
    price: 64,
    originalPrice: 80,
    discountTag: '-20% OFF',
    badge: 'KIDS FAVORITE',
    rating: 4.8,
    reviews: 154,
    category: 'Kids Collection',
    image:
      'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=800&q=85',
    seller: {
      name: 'Claire Lin',
      location: 'Makati, Metro Manila',
      bio: 'Youth & family sneaker boutique • 100% deadstock pairs'
    }
  },
  {
    id: 8,
    brand: 'ADIDAS',
    name: 'ADIDAS TERREX TRAIL RUNNER',
    subtitle: 'Recycled ripstop & Continental lugged grip',
    description:
      'Built for gravel paths and city parks with abrasion-resistant recycled overlays and responsive Lightstrike EVA.',
    specs: [
      '50% recycled ripstop & suede upper',
      'Lightstrike cushioned trail midsole',
      'High-traction lugged rubber outsole',
      'Gusseted tongue blocks trail grit'
    ],
    optionLabel: 'SELECT SIZE',
    options: ['US 8', 'US 9', 'US 10', 'US 11'],
    price: 145,
    badge: 'ECO EDITION',
    rating: 4.8,
    reviews: 132,
    category: 'Performance Series',
    image:
      'https://images.unsplash.com/photo-1587563871167-1ee9c731aefb?auto=format&fit=crop&w=800&q=85',
    seller: {
      name: 'Marcus Vance',
      location: 'Manila, Metro Manila',
      bio: 'Verified Air Max & trail collector • Same-day dispatch'
    }
  },
  {
    id: 9,
    brand: 'ON CLOUD',
    name: 'ON CLOUD 5 KIDS SKY',
    subtitle: 'Speed-lacing slip-on comfort for youth',
    description:
      'Signature On speed-lacing system lets kids slip in and go in seconds with cushioned CloudTec landings.',
    specs: [
      'Zero-tie elastic speed-lacing system',
      'Lightweight CloudTec foam pods',
      'Breathable antimicrobial mesh',
      'Reflective safety accents'
    ],
    optionLabel: 'SELECT YOUTH SIZE',
    options: ['US 1Y', 'US 2Y', 'US 3Y', 'US 4Y'],
    price: 88,
    originalPrice: 110,
    discountTag: '-20% OFF',
    badge: 'KIDS FAVORITE',
    rating: 4.9,
    reviews: 141,
    category: 'Kids Collection',
    image:
      'https://images.unsplash.com/photo-1539185441755-769473a23570?auto=format&fit=crop&w=800&q=85',
    seller: {
      name: 'Claire Lin',
      location: 'Makati, Metro Manila',
      bio: 'Youth & family sneaker boutique • 100% deadstock pairs'
    }
  }
];

const DEFAULT_PRODUCTS = [...BEST_SELLERS, ...EXTRA_CATALOG_PRODUCTS];

const COLLECTIONS = [
  {
    id: 'Performance Series',
    label: 'PERFORMANCE SERIES',
    image:
      'https://images.unsplash.com/photo-1600185365926-3a2ce3cdb9eb?auto=format&fit=crop&w=900&q=85'
  },
  {
    id: 'Limited Edition',
    label: 'LIMITED EDITION',
    image:
      'https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=900&q=85'
  },
  {
    id: 'Kids Collection',
    label: 'KIDS COLLECTION',
    image:
      'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=900&q=85'
  }
];

const CUSTOMER_REVIEWS = [
  {
    id: 1,
    theme: 'dark',
    title: '"ON CLOUD IS UNREAL"',
    body: '"The On Cloudnova Rose Pink is hands down the lightest sneaker I have ever worn. Zero break-in time and plush CloudTec bounce all day."',
    author: 'MARCUS VANCE'
  },
  {
    id: 2,
    theme: 'light',
    title: '"CLASSIC NIKE AIR COMFORT"',
    body: '"My Nike Air Max 1 Crimson arrived in two days. Crisp stitching, vibrant suede, and unbeatable heel cushioning on city walks."',
    author: 'ELENA ROSTOVA'
  },
  {
    id: 3,
    theme: 'dark',
    title: '"ADIDAS ULTRABOOST ENERGY"',
    body: '"Logged 250 miles in the Adidas Ultraboost Obsidian and the Primeknit still hugs like a glove with serious energy return."',
    author: 'DEVON BROOKS'
  },
  {
    id: 4,
    theme: 'light',
    title: '"BEST SELECTION OF ALL THREE"',
    body: '"Love being able to compare Nike, On Cloud, and Adidas side by side in one clean storefront."',
    author: 'CLAIRE LIN'
  }
];

const CATEGORIES = [
  'All',
  'Performance Series',
  'Limited Edition',
  'Kids Collection'
];

const AVAILABLE_SHOE_SIZES = [
  'US 6',
  'US 7',
  'US 8',
  'US 9',
  'US 10',
  'US 11',
  'US 12'
];

const QUICK_CHAT_PROMPTS = [
  'Is this still available?',
  'Can we do a local meetup?',
  'Is the price negotiable?',
  'Does it include the original box?'
];

const DEFAULT_SHOE_PREVIEW =
  'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=800&q=85';

const STORAGE_LISTINGS_KEY = 'solesyndicate_user_listings_v1';
const STORAGE_USERS_KEY = 'solesyndicate_users_v1';
const STORAGE_SESSION_KEY = 'solesyndicate_session_v1';
const STORAGE_ACCOUNT_DATA_PREFIX = 'solesyndicate_account_data_';

function loadLocalAccountData(email) {
  if (!email) {
    return { favorites: [], cart: [], orders: [] };
  }
  try {
    const raw = localStorage.getItem(
      `${STORAGE_ACCOUNT_DATA_PREFIX}${email.trim().toLowerCase()}`
    );
    if (!raw) return { favorites: [], cart: [], orders: [] };
    const parsed = JSON.parse(raw);
    return {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
      cart: Array.isArray(parsed.cart) ? parsed.cart : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders : []
    };
  } catch {
    return { favorites: [], cart: [], orders: [] };
  }
}

function saveLocalAccountData(email, data) {
  if (!email) return;
  try {
    localStorage.setItem(
      `${STORAGE_ACCOUNT_DATA_PREFIX}${email.trim().toLowerCase()}`,
      JSON.stringify({
        favorites: data.favorites || [],
        cart: data.cart || [],
        orders: data.orders || []
      })
    );
  } catch {
    // Ignore storage quota warnings
  }
}

const FREE_SHIPPING_THRESHOLD = 150;

const formatMoney = (amount) =>
  amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

const getOptionTypeName = (optionLabel = 'SELECT SIZE') => {
  const raw = optionLabel.replace(/^SELECT\s+/i, '').toLowerCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

export default function App() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [wishlistOnly, setWishlistOnly] = useState(false);
  const [selectedBrands, setSelectedBrands] = useState([]);
  const [sortBy, setSortBy] = useState('featured');
  const [showCart, setShowCart] = useState(false);

  // Gmail / Google OAuth 2.0 Authentication & Per-Account State
  const [registeredUsers, setRegisteredUsers] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_USERS_KEY) || '[]');
    } catch {
      return [];
    }
  });
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  });

  // Per-account Bag, Saved Wishlist, and Order History (resets on logout / new account, restores on old account login)
  const [cart, setCart] = useState(() => {
    try {
      const savedUser = JSON.parse(
        localStorage.getItem(STORAGE_SESSION_KEY) || 'null'
      );
      return savedUser ? loadLocalAccountData(savedUser.email).cart : [];
    } catch {
      return [];
    }
  });
  const [favorites, setFavorites] = useState(() => {
    try {
      const savedUser = JSON.parse(
        localStorage.getItem(STORAGE_SESSION_KEY) || 'null'
      );
      return savedUser ? loadLocalAccountData(savedUser.email).favorites : [];
    } catch {
      return [];
    }
  });
  const [orders, setOrders] = useState(() => {
    try {
      const savedUser = JSON.parse(
        localStorage.getItem(STORAGE_SESSION_KEY) || 'null'
      );
      return savedUser ? loadLocalAccountData(savedUser.email).orders : [];
    } catch {
      return [];
    }
  });
  const [isAccountHydrated, setIsAccountHydrated] = useState(true);

  const [authModalMode, setAuthModalMode] = useState(null);
  const [showAccountHub, setShowAccountHub] = useState(false);

  // Community seller listings (visible to all users, deletable only by seller)
  const [userListings, setUserListings] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_LISTINGS_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [isPublishing, setIsPublishing] = useState(false);

  // Real User-to-User Chat Drawer & Conversation Threads (NO automatic bot replies)
  const [chatThreads, setChatThreads] = useState({});
  const [activeThreadKey, setActiveThreadKey] = useState(null);
  const [isChatDrawerOpen, setIsChatDrawerOpen] = useState(false);
  const [waitingSellerProduct, setWaitingSellerProduct] = useState(null);
  const [chatInput, setChatInput] = useState('');
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const chatMessagesEndRef = useRef(null);

  // Sell / List a Product Modal & Form State
  const [showSellModal, setShowSellModal] = useState(false);
  const [pendingOpenSell, setPendingOpenSell] = useState(false);
  const [pendingChatProduct, setPendingChatProduct] = useState(null);
  const [listingToast, setListingToast] = useState('');

  const [shoeBrand, setShoeBrand] = useState('NIKE');
  const [customBrand, setCustomBrand] = useState('');
  const [shoeName, setShoeName] = useState('');
  const [shoeCategory, setShoeCategory] = useState('Limited Edition');
  const [shoeCondition, setShoeCondition] = useState(
    'Brand New Deadstock • Original Box'
  );
  const [shoePrice, setShoePrice] = useState('');
  const [shoeOriginalPrice, setShoeOriginalPrice] = useState('');
  const [shoeSizes, setShoeSizes] = useState(['US 9', 'US 10']);
  const [shoeDescription, setShoeDescription] = useState('');
  const [shoeImage, setShoeImage] = useState('');
  const [shoeImageFile, setShoeImageFile] = useState(null);
  const [shoeImageUrlInput, setShoeImageUrlInput] = useState('');
  const [sellFormError, setSellFormError] = useState('');

  const allProducts = useMemo(
    () => [...userListings, ...DEFAULT_PRODUCTS],
    [userListings]
  );

  const [heroSlides, setHeroSlides] = useState(() =>
    shuffleSlides(HERO_SHOE_SLIDES)
  );
  const [slideIndex, setSlideIndex] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [cardTilt, setCardTilt] = useState({ rx: 0, ry: 0 });
  const dragStartXRef = useRef(null);

  const headerRef = useRef(null);
  const [headerHeight, setHeaderHeight] = useState(125);
  const [reviewOffset, setReviewOffset] = useState(0);

  const [newsletterEmail, setNewsletterEmail] = useState('');
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [newsletterSubmitted, setNewsletterSubmitted] = useState(false);

  const [showSustainabilityModal, setShowSustainabilityModal] = useState(false);

  const [promoInput, setPromoInput] = useState('');
  const [appliedPromo, setAppliedPromo] = useState('');
  const [promoError, setPromoError] = useState('');

  const [quickViewProduct, setQuickViewProduct] = useState(null);
  const [selectedOption, setSelectedOption] = useState('');
  const [modalQty, setModalQty] = useState(1);

  const activeSlide = heroSlides[slideIndex] || heroSlides[0];
  const slideNumberLabel = String(slideIndex + 1).padStart(2, '0');

  // 1. Load & subscribe to all seller listings in Supabase
  useEffect(() => {
    if (!isSupabaseConfigured) return;

    let cancelled = false;

    const loadAllListings = () => {
      fetchListingsFromSupabase()
        .then((rows) => {
          if (!cancelled) {
            setUserListings(rows);
          }
        })
        .catch((err) => {
          console.error('Supabase fetch error:', err.message);
        });
    };

    loadAllListings();
    const unsubscribe = subscribeToListings(loadAllListings);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // 2. Load & subscribe to REAL user-to-user messages for the logged-in user
  useEffect(() => {
    if (!currentUser?.email) {
      setChatThreads({});
      setActiveThreadKey(null);
      setIsChatDrawerOpen(false);
      return;
    }

    if (!isSupabaseConfigured) return;

    let cancelled = false;
    const syncMessages = () => {
      fetchUserMessagesFromSupabase(currentUser.email)
        .then((rows) => {
          if (cancelled) return;
          const grouped = groupMessageRowsIntoThreads(rows);
          setChatThreads((prev) => {
            // Preserve any newly opened empty draft thread while merging live DB messages
            const merged = { ...grouped };
            Object.keys(prev).forEach((k) => {
              if (!merged[k] && prev[k]?.messages?.length === 0) {
                merged[k] = prev[k];
              }
            });
            return merged;
          });
        })
        .catch((err) => {
          console.error('Messages fetch error:', err.message);
        });
    };

    syncMessages();
    const unsubscribe = subscribeToUserMessages(currentUser.email, syncMessages);
    const pollInterval = setInterval(syncMessages, 4000);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(pollInterval);
    };
  }, [currentUser?.email]);

  // 3. Auto-save logged-in user's Bag, Saved Wishlist, and Orders whenever they change
  useEffect(() => {
    if (!currentUser?.email || !isAccountHydrated) return;

    const stateSnapshot = { favorites, cart, orders };
    saveLocalAccountData(currentUser.email, stateSnapshot);

    if (isSupabaseConfigured) {
      saveUserAccountToSupabase(currentUser, stateSnapshot);
    }
  }, [currentUser, favorites, cart, orders, isAccountHydrated]);

  // 4. Hydrate old account data from Supabase on page refresh if signed in
  useEffect(() => {
    if (!currentUser?.email || !isSupabaseConfigured) return;
    let cancelled = false;

    fetchUserAccountFromSupabase(currentUser.email).then((cloudRow) => {
      if (cancelled || !cloudRow) return;
      const localData = loadLocalAccountData(currentUser.email);
      const nextFavs =
        Array.isArray(cloudRow.favorites) && cloudRow.favorites.length > 0
          ? cloudRow.favorites
          : localData.favorites;
      const nextCart =
        Array.isArray(cloudRow.cart) && cloudRow.cart.length > 0
          ? cloudRow.cart
          : localData.cart;
      const nextOrders =
        Array.isArray(cloudRow.orders) && cloudRow.orders.length > 0
          ? cloudRow.orders
          : localData.orders;

      setFavorites(nextFavs);
      setCart(nextCart);
      setOrders(nextOrders);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const openSellPortal = () => {
    if (!currentUser) {
      setPendingOpenSell(true);
      setAuthModalMode('login');
      return;
    }
    setShowSellModal(true);
  };

  // Start or open a REAL buyer-seller message thread (requires login, NO bot replies)
  const startConversationForProduct = (product, loggedInUser = currentUser) => {
    if (!product || !loggedInUser?.email) return;

    const myEmail = loggedInUser.email.trim().toLowerCase();
    const seller = getProductSeller(product);
    const sellerEmail = (
      product.ownerEmail || 'concierge@solesyndicate.com'
    )
      .trim()
      .toLowerCase();

    setQuickViewProduct(null);
    setShowCart(false);
    setChatInput('');

    // Case A: The logged-in user IS the seller of this product
    if (myEmail === sellerEmail) {
      const matchingBuyerThreads = Object.values(chatThreads).filter(
        (t) => t.listingId === String(product.id)
      );

      if (matchingBuyerThreads.length > 0) {
        const latestThread =
          matchingBuyerThreads[matchingBuyerThreads.length - 1];
        setWaitingSellerProduct(null);
        setActiveThreadKey(latestThread.threadKey);
        setIsChatDrawerOpen(true);
      } else {
        setActiveThreadKey(null);
        setWaitingSellerProduct(product);
        setIsChatDrawerOpen(true);
      }
      return;
    }

    // Case B: The logged-in user is a BUYER messaging the seller
    const key = buildThreadKey(product.id, myEmail);
    setWaitingSellerProduct(null);

    setChatThreads((prev) => {
      if (prev[key]) return prev;
      return {
        ...prev,
        [key]: {
          threadKey: key,
          listingId: String(product.id),
          listingName: product.name,
          listingImage: product.image,
          listingPrice: product.price,
          sellerEmail,
          sellerName: seller.name,
          sellerUserId: product.ownerId || null,
          buyerEmail: myEmail,
          buyerName: loggedInUser.name || myEmail.split('@')[0],
          buyerUserId: loggedInUser.id || null,
          messages: []
        }
      };
    });

    setActiveThreadKey(key);
    setIsChatDrawerOpen(true);
  };

  const openChatWithSeller = (product) => {
    const targetProduct = product || allProducts[0];
    if (!targetProduct) return;

    if (!currentUser) {
      setPendingChatProduct(targetProduct);
      setAuthModalMode('login');
      return;
    }

    startConversationForProduct(targetProduct, currentUser);
  };

  const openMessagesInbox = () => {
    if (!currentUser) {
      setAuthModalMode('login');
      return;
    }

    const threads = Object.values(chatThreads);
    if (threads.length > 0) {
      const latest = threads[threads.length - 1];
      setWaitingSellerProduct(null);
      setActiveThreadKey(latest.threadKey);
      setIsChatDrawerOpen(true);
    } else {
      setActiveThreadKey(null);
      setWaitingSellerProduct(null);
      setIsChatDrawerOpen(true);
    }
  };

  const handleCompleteAuth = async (userObj, isNewRegistration) => {
    setIsAccountHydrated(false);
    const cleanEmail = userObj.email.trim().toLowerCase();
    const normalizedUser = { ...userObj, email: cleanEmail };

    setRegisteredUsers((prev) => {
      const filtered = prev.filter(
        (u) => u.email.toLowerCase() !== cleanEmail
      );
      const next = [normalizedUser, ...filtered];
      try {
        localStorage.setItem(STORAGE_USERS_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });

    // Reset transient UI state (filters, promo codes, open drawers)
    setAppliedPromo('');
    setPromoInput('');
    setPromoError('');
    setWishlistOnly(false);
    setSelectedBrands([]);
    setCategory('All');
    setQuery('');
    setChatThreads({});
    setActiveThreadKey(null);
    setIsChatDrawerOpen(false);
    setWaitingSellerProduct(null);

    if (isNewRegistration) {
      // NEW ACCOUNT: Reset everything to a fresh empty state
      const freshState = { favorites: [], cart: [], orders: [] };
      setFavorites([]);
      setCart([]);
      setOrders([]);
      saveLocalAccountData(cleanEmail, freshState);

      if (isSupabaseConfigured) {
        await saveUserAccountToSupabase(normalizedUser, freshState);
      }
    } else {
      // OLD ACCOUNT: Restore everything saved before the user logged out
      let restored = loadLocalAccountData(cleanEmail);

      if (userObj.savedState) {
        restored = {
          favorites: userObj.savedState.favorites || restored.favorites,
          cart: userObj.savedState.cart || restored.cart,
          orders: userObj.savedState.orders || restored.orders
        };
      } else if (isSupabaseConfigured) {
        const cloudRow = await fetchUserAccountFromSupabase(cleanEmail);
        if (cloudRow) {
          restored = {
            favorites: Array.isArray(cloudRow.favorites)
              ? cloudRow.favorites
              : restored.favorites,
            cart: Array.isArray(cloudRow.cart) ? cloudRow.cart : restored.cart,
            orders: Array.isArray(cloudRow.orders)
              ? cloudRow.orders
              : restored.orders
          };
        }
      }

      setFavorites(restored.favorites);
      setCart(restored.cart);
      setOrders(restored.orders);
      saveLocalAccountData(cleanEmail, restored);
    }

    setCurrentUser(normalizedUser);
    try {
      localStorage.setItem(
        STORAGE_SESSION_KEY,
        JSON.stringify(normalizedUser)
      );
    } catch {
      // Ignore storage errors
    }
    setIsAccountHydrated(true);
    setAuthModalMode(null);

    if (pendingOpenSell) {
      setPendingOpenSell(false);
      setShowSellModal(true);
    } else if (pendingChatProduct) {
      const targetProd = pendingChatProduct;
      setPendingChatProduct(null);
      startConversationForProduct(targetProd, normalizedUser);
    }

    setListingToast(
      isNewRegistration
        ? `New account created for ${normalizedUser.name}! Starting fresh.`
        : `Welcome back, ${normalizedUser.name}! Your saved items, bag, and messages are restored.`
    );
    setTimeout(() => setListingToast(''), 5500);
  };

  const handleUpdateUserProfile = async (updatedUser) => {
    setCurrentUser(updatedUser);
    try {
      localStorage.setItem(STORAGE_SESSION_KEY, JSON.stringify(updatedUser));
    } catch {
      // Ignore storage errors
    }
    setRegisteredUsers((prev) => {
      const next = prev.map((u) =>
        u.email.toLowerCase() === updatedUser.email.toLowerCase()
          ? updatedUser
          : u
      );
      try {
        localStorage.setItem(STORAGE_USERS_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });

    if (isSupabaseConfigured) {
      await saveUserAccountToSupabase(updatedUser, {
        favorites,
        cart,
        orders
      });
    }
  };

  const handleSignOut = async () => {
    // 1. Persist everything the user did before logging out
    if (currentUser?.email) {
      const snapshot = { favorites, cart, orders };
      saveLocalAccountData(currentUser.email, snapshot);
      if (isSupabaseConfigured) {
        await saveUserAccountToSupabase(currentUser, snapshot);
      }
    }

    if (currentUser?.accessToken) {
      signOutGoogleSession(currentUser.accessToken);
    }
    if (isSupabaseConfigured) {
      await signOutOfSupabase();
    }

    // 2. Reset all active session state for the next visitor / new account
    setIsAccountHydrated(false);
    setCurrentUser(null);
    setFavorites([]);
    setCart([]);
    setOrders([]);
    setChatThreads({});
    setActiveThreadKey(null);
    setIsChatDrawerOpen(false);
    setWaitingSellerProduct(null);
    setAppliedPromo('');
    setPromoInput('');
    setPromoError('');
    setWishlistOnly(false);
    setSelectedBrands([]);
    setCategory('All');
    setQuery('');
    setShowAccountHub(false);
    setShowSellModal(false);
    setShowCart(false);

    try {
      localStorage.removeItem(STORAGE_SESSION_KEY);
    } catch {
      // Ignore storage errors
    }

    setIsAccountHydrated(true);
    setListingToast('Saved your progress and signed out.');
    setTimeout(() => setListingToast(''), 4000);
  };

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_LISTINGS_KEY, JSON.stringify(userListings));
    } catch {
      // Ignore storage quota warnings
    }
  }, [userListings]);

  useEffect(() => {
    if (isChatDrawerOpen && chatMessagesEndRef.current) {
      chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isChatDrawerOpen, activeThreadKey, chatThreads]);

  useEffect(() => {
    const measureHeader = () => {
      if (headerRef.current) {
        setHeaderHeight(headerRef.current.offsetHeight);
      }
    };
    measureHeader();
    window.addEventListener('resize', measureHeader);
    return () => window.removeEventListener('resize', measureHeader);
  }, []);

  useEffect(() => {
    const targets = Array.from(document.querySelectorAll('[data-scroll-up]'));
    if (!targets.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
          } else if (entry.boundingClientRect.top > window.innerHeight * 0.94) {
            entry.target.classList.remove('is-visible');
          }
        });
      },
      {
        threshold: 0.08,
        rootMargin: '0px 0px -24px 0px'
      }
    );

    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [category, wishlistOnly, selectedBrands, sortBy, query, userListings]);

  const prevSlide = () => {
    setSlideIndex((i) => (i - 1 + heroSlides.length) % heroSlides.length);
  };

  const nextSlide = () => {
    setSlideIndex((i) => (i + 1) % heroSlides.length);
  };

  const handleRandomizeHero = () => {
    setHeroSlides((prev) => shuffleSlides(prev));
    setSlideIndex(0);
  };

  const handleHeroPointerDown = (e) => {
    if (
      e.target.closest('button') ||
      e.target.closest('.card') ||
      e.target.closest('.hero-sale-floating-card')
    ) {
      return;
    }
    dragStartXRef.current = e.clientX;
    setIsDragging(true);
  };

  const handleHeroPointerMove = (e) => {
    if (!isDragging || dragStartXRef.current === null) return;
    setDragOffset(e.clientX - dragStartXRef.current);
  };

  const handleHeroPointerEnd = () => {
    if (!isDragging) return;
    if (dragOffset <= -50) {
      nextSlide();
    } else if (dragOffset >= 50) {
      prevSlide();
    }
    dragStartXRef.current = null;
    setIsDragging(false);
    setDragOffset(0);
  };

  const handle3DCardMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setCardTilt({ rx: -y * 16, ry: x * 20 });
  };

  const handle3DCardMouseLeave = () => {
    setCardTilt({ rx: 0, ry: 0 });
  };

  const openQuickView = (product) => {
    setQuickViewProduct(product);
    setSelectedOption(product.options?.[0] || '');
    setModalQty(1);
  };

  const closeQuickView = () => {
    setQuickViewProduct(null);
  };

  // Send a REAL message to the other user (NO automatic bot reply)
  const sendChatMessage = async (rawText) => {
    const trimmed = rawText.trim();
    if (!trimmed || !activeThreadKey || !currentUser || isSendingMessage) return;

    const currentThread = chatThreads[activeThreadKey];
    if (!currentThread) return;

    const myEmail = currentUser.email.trim().toLowerCase();
    const myName = currentUser.name || myEmail.split('@')[0];

    setIsSendingMessage(true);
    setChatInput('');

    try {
      const savedRow = await sendMessageInSupabase({
        listing_id: currentThread.listingId,
        listing_name: currentThread.listingName,
        listing_image: currentThread.listingImage,
        listing_price: currentThread.listingPrice,
        seller_email: currentThread.sellerEmail,
        seller_name: currentThread.sellerName,
        buyer_email: currentThread.buyerEmail,
        buyer_name: currentThread.buyerName,
        sender_email: myEmail,
        sender_name: myName,
        buyer_user_id: currentThread.buyerUserId,
        seller_user_id: currentThread.sellerUserId,
        message_text: trimmed
      });

      const newMsgObj = {
        id: savedRow.id,
        senderEmail: myEmail,
        senderName: myName,
        text: trimmed,
        time: formatMessageTimestamp(savedRow.created_at),
        createdAt: savedRow.created_at
      };

      setChatThreads((prev) => {
        const existing = prev[activeThreadKey] || currentThread;
        const alreadyPresent = existing.messages.some(
          (m) => m.id === newMsgObj.id
        );
        return {
          ...prev,
          [activeThreadKey]: {
            ...existing,
            messages: alreadyPresent
              ? existing.messages
              : [...existing.messages, newMsgObj]
          }
        };
      });
    } catch (err) {
      setListingToast(err.message || 'Unable to send message.');
      setTimeout(() => setListingToast(''), 4000);
    } finally {
      setIsSendingMessage(false);
    }
  };

  const deleteChatThread = async (threadKeyToRemove) => {
    const target = chatThreads[threadKeyToRemove];
    if (!target) return;

    try {
      if (isSupabaseConfigured) {
        await deleteConversationInSupabase(
          target.listingId,
          target.buyerEmail
        );
      }

      const updated = { ...chatThreads };
      delete updated[threadKeyToRemove];
      setChatThreads(updated);

      if (activeThreadKey === threadKeyToRemove) {
        const remaining = Object.values(updated);
        if (remaining.length > 0) {
          setActiveThreadKey(remaining[remaining.length - 1].threadKey);
        } else {
          setActiveThreadKey(null);
          setIsChatDrawerOpen(false);
        }
      }
    } catch (err) {
      setListingToast(err.message || 'Failed to delete conversation.');
      setTimeout(() => setListingToast(''), 4000);
    }
  };

  useEffect(() => {
    if (
      !quickViewProduct &&
      !showCart &&
      !showSustainabilityModal &&
      !showSellModal &&
      !isChatDrawerOpen &&
      !authModalMode &&
      !showAccountHub
    ) {
      return;
    }
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (authModalMode) {
          setAuthModalMode(null);
          setPendingOpenSell(false);
          setPendingChatProduct(null);
        } else if (showAccountHub) setShowAccountHub(false);
        else if (isChatDrawerOpen) setIsChatDrawerOpen(false);
        else if (showSellModal) setShowSellModal(false);
        else if (quickViewProduct) closeQuickView();
        else if (showCart) setShowCart(false);
        else if (showSustainabilityModal) setShowSustainabilityModal(false);
      }
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    quickViewProduct,
    showCart,
    showSustainabilityModal,
    showSellModal,
    isChatDrawerOpen,
    authModalMode,
    showAccountHub
  ]);

  const categoryCounts = useMemo(() => {
    const counts = { All: allProducts.length };
    CATEGORIES.slice(1).forEach((cat) => {
      counts[cat] = allProducts.filter((p) => p.category === cat).length;
    });
    return counts;
  }, [allProducts]);

  const brands = useMemo(() => {
    const map = new Map();
    allProducts.forEach((p) => {
      map.set(p.brand, (map.get(p.brand) || 0) + 1);
    });
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allProducts]);

  const shown = useMemo(() => {
    const filtered = allProducts.filter((p) => {
      const matchesCategory = category === 'All' || p.category === category;
      const matchesWishlist = !wishlistOnly || favorites.includes(p.id);
      const matchesBrand =
        selectedBrands.length === 0 || selectedBrands.includes(p.brand);
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.brand.toLowerCase().includes(q) ||
        p.subtitle.toLowerCase().includes(q) ||
        (p.seller?.name && p.seller.name.toLowerCase().includes(q)) ||
        (p.seller?.location && p.seller.location.toLowerCase().includes(q));
      return matchesCategory && matchesWishlist && matchesBrand && matchesQuery;
    });

    const sorted = [...filtered];
    if (sortBy === 'price-asc') {
      sorted.sort((a, b) => a.price - b.price);
    } else if (sortBy === 'price-desc') {
      sorted.sort((a, b) => b.price - a.price);
    } else if (sortBy === 'rating') {
      sorted.sort((a, b) => b.rating - a.rating || b.reviews - a.reviews);
    } else if (sortBy === 'reviews') {
      sorted.sort((a, b) => b.reviews - a.reviews);
    }
    return sorted;
  }, [
    allProducts,
    category,
    wishlistOnly,
    favorites,
    selectedBrands,
    query,
    sortBy
  ]);

  const toggleFavorite = (id) => {
    setFavorites((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleBrand = (brandName) => {
    setSelectedBrands((prev) =>
      prev.includes(brandName)
        ? prev.filter((b) => b !== brandName)
        : [...prev, brandName]
    );
  };

  const toggleShoeSize = (size) => {
    setShoeSizes((prev) =>
      prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size]
    );
  };

  const resetFilters = () => {
    setCategory('All');
    setWishlistOnly(false);
    setSelectedBrands([]);
    setSortBy('featured');
    setQuery('');
  };

  const scrollToSection = (sectionId, filterCat = null) => {
    if (filterCat) {
      setCategory(filterCat);
      setWishlistOnly(false);
    }
    if (sectionId === 'top-hero') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const el = document.getElementById(sectionId);
    if (el) {
      const y =
        el.getBoundingClientRect().top + window.scrollY - headerHeight + 2;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  };

  const handleShoePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setShoeImageFile(file);
    const compressed = await compressImageFile(file, 800, 0.84);
    setShoeImage(compressed);
    setShoeImageUrlInput('');
  };

  const handlePublishListing = async (e) => {
    e.preventDefault();
    setSellFormError('');

    if (!currentUser) {
      setShowSellModal(false);
      setPendingOpenSell(true);
      setAuthModalMode('login');
      return;
    }

    const cleanShoeName = shoeName.trim();
    const numericPrice = Number(shoePrice);
    const numericOrigPrice = shoeOriginalPrice
      ? Number(shoeOriginalPrice)
      : null;

    const finalBrand = (
      shoeBrand === 'OTHER' ? customBrand.trim() : shoeBrand
    ).toUpperCase();

    if (!finalBrand) {
      setSellFormError('Please specify the sneaker brand.');
      return;
    }
    if (!cleanShoeName) {
      setSellFormError('Please enter the sneaker model name.');
      return;
    }
    if (!numericPrice || numericPrice <= 0) {
      setSellFormError('Please enter a valid selling price.');
      return;
    }
    if (shoeSizes.length === 0) {
      setSellFormError('Please select at least one available size.');
      return;
    }

    setIsPublishing(true);

    try {
      let finalImage =
        shoeImage || shoeImageUrlInput.trim() || DEFAULT_SHOE_PREVIEW;

      if (shoeImageFile && isSupabaseConfigured) {
        const publicUrl = await uploadSneakerImageToSupabase(shoeImageFile);
        if (publicUrl) {
          finalImage = publicUrl;
        }
      }

      const sellerName = currentUser.name || currentUser.email.split('@')[0];
      const sellerLocation = currentUser.location || 'Verified Seller';

      const profileObj = {
        name: sellerName,
        location: sellerLocation,
        avatar: currentUser.avatar || '',
        bio:
          currentUser.bio ||
          'Verified SoleSyndicate community seller • Fast dispatch'
      };

      const discountPct =
        numericOrigPrice && numericOrigPrice > numericPrice
          ? `-${Math.round(
              ((numericOrigPrice - numericPrice) / numericOrigPrice) * 100
            )}% OFF`
          : null;

      const draftProduct = {
        id: Date.now(),
        isUserListing: true,
        ownerEmail: currentUser.email.trim().toLowerCase(),
        brand: finalBrand,
        name: cleanShoeName.toUpperCase(),
        subtitle: shoeCondition.trim() || 'Community Verified Listing',
        description:
          shoeDescription.trim() ||
          `Listed by ${sellerName} in ${sellerLocation}. Inspected and ready for local meetup or tracked shipping.`,
        specs: [
          `Condition: ${shoeCondition.trim() || 'Excellent / Deadstock'}`,
          `Seller Location: ${sellerLocation}`,
          `Listed by: ${sellerName}`,
          'Includes original box & verified SoleSyndicate buyer protection'
        ],
        optionLabel: 'SELECT SIZE',
        options: shoeSizes,
        price: numericPrice,
        originalPrice:
          numericOrigPrice && numericOrigPrice > numericPrice
            ? numericOrigPrice
            : undefined,
        discountTag: discountPct || undefined,
        badge: 'SELLER LISTING',
        rating: 5.0,
        reviews: 1,
        category: shoeCategory,
        image: finalImage,
        seller: {
          ...profileObj,
          listedAt: new Date().toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          })
        }
      };

      const savedProduct = isSupabaseConfigured
        ? await createListingInSupabase(draftProduct)
        : draftProduct;

      setUserListings((prev) => [savedProduct, ...prev]);

      setShoeName('');
      setShoePrice('');
      setShoeOriginalPrice('');
      setShoeDescription('');
      setShoeImage('');
      setShoeImageFile(null);
      setShoeImageUrlInput('');
      setShowSellModal(false);

      resetFilters();
      scrollToSection('catalog-storefront', 'All');
      setListingToast(
        isSupabaseConfigured
          ? `Saved to Supabase & listed "${savedProduct.name}" under ${sellerName}!`
          : `Listed "${savedProduct.name}" under ${sellerName}!`
      );
      setTimeout(() => setListingToast(''), 5500);
    } catch (err) {
      setSellFormError(err.message || 'Failed to publish listing to Supabase.');
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDeleteUserListing = async (productId) => {
    const targetListing = userListings.find((item) => item.id === productId);
    if (!targetListing) return;

    if (!isListingOwner(targetListing, currentUser)) {
      setListingToast('Only the seller who listed this sneaker can delete it.');
      setTimeout(() => setListingToast(''), 4000);
      return;
    }

    try {
      if (isSupabaseConfigured) {
        await deleteListingFromSupabase(productId, currentUser.email);
      }

      setUserListings((prev) => prev.filter((item) => item.id !== productId));
      setFavorites((prev) => prev.filter((id) => id !== productId));
      if (quickViewProduct?.id === productId) {
        closeQuickView();
      }
      setListingToast(`Removed "${targetListing.name}" from the marketplace.`);
      setTimeout(() => setListingToast(''), 4000);
    } catch (err) {
      setListingToast(err.message || 'Unable to delete listing.');
      setTimeout(() => setListingToast(''), 4500);
    }
  };

  const add = (p, qty = 1, option = p.options?.[0] || '') => {
    const cartKey = `${p.id}-${option}`;
    setCart((old) => {
      const item = old.find((x) => x.cartKey === cartKey);
      return item
        ? old.map((x) =>
            x.cartKey === cartKey ? { ...x, qty: x.qty + qty } : x
          )
        : [...old, { ...p, cartKey, selectedOption: option, qty }];
    });
  };

  const updateCartQty = (cartKey, delta) => {
    setCart((old) =>
      old
        .map((item) =>
          item.cartKey === cartKey ? { ...item, qty: item.qty + delta } : item
        )
        .filter((item) => item.qty > 0)
    );
  };

  const removeFromCart = (cartKey) => {
    setCart((old) => old.filter((item) => item.cartKey !== cartKey));
  };

  const totalItems = cart.reduce((sum, x) => sum + x.qty, 0);
  const subtotal = cart.reduce((sum, x) => sum + x.price * x.qty, 0);
  const promoDiscount = appliedPromo === 'STRIDE20' ? subtotal * 0.2 : 0;
  const discountedSubtotal = Math.max(0, subtotal - promoDiscount);
  const freeShippingRemaining = Math.max(
    0,
    FREE_SHIPPING_THRESHOLD - discountedSubtotal
  );
  const shippingProgressPct = Math.min(
    100,
    (discountedSubtotal / FREE_SHIPPING_THRESHOLD) * 100
  );
  const shippingFee =
    discountedSubtotal === 0 || discountedSubtotal >= FREE_SHIPPING_THRESHOLD
      ? 0
      : 12;
  const grandTotal = discountedSubtotal + shippingFee;

  const handleApplyPromo = (e) => {
    e.preventDefault();
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    if (code === 'STRIDE20') {
      setAppliedPromo('STRIDE20');
      setPromoError('');
      setPromoInput('');
    } else {
      setPromoError('Invalid code. Try STRIDE20 for 20% off.');
    }
  };

  const handleNewsletterSubmit = (e) => {
    e.preventDefault();
    if (!newsletterEmail.trim()) return;
    setNewsletterSubmitted(true);
    setNewsletterEmail('');
  };

  const visibleReviews = [
    CUSTOMER_REVIEWS[reviewOffset % CUSTOMER_REVIEWS.length],
    CUSTOMER_REVIEWS[(reviewOffset + 1) % CUSTOMER_REVIEWS.length]
  ];

  const hasActiveFilters =
    category !== 'All' ||
    wishlistOnly ||
    selectedBrands.length > 0 ||
    query.trim() !== '';

  const activeThreadsList = Object.values(chatThreads);
  const activeThread = activeThreadKey ? chatThreads[activeThreadKey] : null;
  const myEmailLower = (currentUser?.email || '').trim().toLowerCase();
  const isCurrentUserSellerInThread =
    activeThread && activeThread.sellerEmail === myEmailLower;
  const chatCounterpartName = activeThread
    ? isCurrentUserSellerInThread
      ? activeThread.buyerName
      : activeThread.sellerName
    : waitingSellerProduct
    ? 'Buyer Inquiries'
    : 'Messages';
  const chatCounterpartRoleLabel = activeThread
    ? isCurrentUserSellerInThread
      ? `Buyer (${activeThread.buyerEmail})`
      : `Seller (${activeThread.sellerEmail})`
    : waitingSellerProduct
    ? 'Your Listing'
    : 'Direct User-to-User Chat';
  const activeThreadProductObj = activeThread
    ? allProducts.find((p) => String(p.id) === activeThread.listingId) || {
        id: activeThread.listingId,
        name: activeThread.listingName,
        image: activeThread.listingImage,
        price: activeThread.listingPrice,
        brand: 'SNEAKER',
        options: ['US 9']
      }
    : waitingSellerProduct;

  return (
    <div
      className="site"
      style={{ '--header-height': `${headerHeight}px` }}
    >
      {/* STICKY EDITORIAL HEADER */}
      <header className="topbar" ref={headerRef}>
        <a
          href="#top-hero"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            scrollToSection('top-hero');
          }}
        >
          SoleSyndicate<span>.</span>
        </a>

        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            scrollToSection('catalog-storefront');
          }}
        >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sneakers, sellers, or location..."
            aria-label="Search sneakers"
          />
          <button type="submit" aria-label="Search">
            ⌕
          </button>
        </form>

        <div className="header-pills">

  <AiShoeScanner />

  {/* Your existing buttons stay here */}
          <button
            type="button"
            className="sell-pill-btn"
            onClick={openSellPortal}
          >
            <span>+</span>
            <span>Sell Sneakers</span>
          </button>

          <button
            type="button"
            className="inbox-pill-btn"
            onClick={openMessagesInbox}
          >
            <span>💬</span>
            <span>Messages</span>
            {activeThreadsList.length > 0 && (
              <span className="inbox-pill-count">
                {activeThreadsList.length}
              </span>
            )}
          </button>

          <button
            type="button"
            className={`saved-pill-btn ${wishlistOnly ? 'active' : ''}`}
            onClick={() => {
              setWishlistOnly((prev) => !prev);
              scrollToSection('catalog-storefront');
            }}
          >
            <span>Saved</span>
            <span className="saved-pill-count">{favorites.length}</span>
          </button>

          <button
            type="button"
            className="bag-pill-btn"
            onClick={() => setShowCart(true)}
          >
            <span>Bag</span>
            <span className="bag-pill-count">{totalItems}</span>
          </button>

          {currentUser ? (
            <button
              type="button"
              className="auth-user-pill"
              onClick={() => setShowAccountHub(true)}
              title={`Signed in as ${currentUser.email}`}
            >
              {currentUser.avatar ? (
                <img
                  src={currentUser.avatar}
                  alt={currentUser.name}
                  className="auth-user-pill-avatar"
                />
              ) : (
                <span className="auth-user-pill-initials">
                  {getInitials(currentUser.name)}
                </span>
              )}
              <span className="auth-user-pill-name">
                {currentUser.name.split(' ')[0]}
              </span>
              {currentUser.emailVerified && (
                <span className="auth-verified-dot" />
              )}
            </button>
          ) : (
            <button
              type="button"
              className="auth-header-btn"
              onClick={() => setAuthModalMode('login')}
            >
              <span>Sign In / Register</span>
            </button>
          )}
        </div>

        <nav aria-label="Primary navigation">
          <button
            type="button"
            onClick={() => scrollToSection('bestsellers-section')}
          >
            BEST SELLERS
          </button>
          <button
            type="button"
            onClick={() =>
              scrollToSection('catalog-storefront', 'Performance Series')
            }
          >
            PERFORMANCE
          </button>
          <button
            type="button"
            onClick={() =>
              scrollToSection('catalog-storefront', 'Limited Edition')
            }
          >
            LIMITED EDITION
          </button>
          <button
            type="button"
            onClick={() => scrollToSection('kids-promo-section')}
          >
            KIDS 20% OFF
          </button>
          <button type="button" onClick={openSellPortal}>
            + LIST YOUR SHOES
          </button>
          <button
            type="button"
            onClick={() => scrollToSection('catalog-storefront', 'All')}
          >
            SHOP ALL
          </button>
        </nav>
      </header>

      {/* PINNED 3D INTERACTIVE HERO SHOWCASE */}
      <section
        id="top-hero"
        className={`ryst-hero ${activeSlide.isLightHero ? 'light-hero' : ''} ${
          isDragging ? 'dragging' : ''
        }`}
        style={{ background: activeSlide.bannerBg }}
        onPointerDown={handleHeroPointerDown}
        onPointerMove={handleHeroPointerMove}
        onPointerUp={handleHeroPointerEnd}
        onPointerCancel={handleHeroPointerEnd}
      >
        <button
          type="button"
          className="hero-nav-arrow prev"
          aria-label="Previous sneaker"
          onClick={prevSlide}
        >
          ‹
        </button>

        <button
          type="button"
          className="hero-nav-arrow next"
          aria-label="Next sneaker"
          onClick={nextSlide}
        >
          ›
        </button>

        <div className="ryst-hero-inner">
          <div className="ryst-hero-left">
            <h1 className="ryst-hero-title">{activeSlide.headline}</h1>
            <p className="ryst-hero-subtitle">{activeSlide.subcopy}</p>

            <div className="ryst-hero-cta-row">
              <button
                type="button"
                className="ryst-pill-btn dark"
                onClick={() => scrollToSection('catalog-storefront', 'All')}
              >
                SHOP COLLECTION
              </button>
              <button
                type="button"
                className="ryst-pill-btn light-outline"
                onClick={openSellPortal}
              >
                + SELL YOUR PAIR
              </button>
              <button
                type="button"
                className="ryst-shuffle-btn"
                onClick={handleRandomizeHero}
              >
                ↻ Shuffle
              </button>
            </div>

            <div className="ryst-swatch-bar" role="tablist" aria-label="Colorways">
              {heroSlides.map((slide, idx) => (
                <button
                  key={slide.id}
                  type="button"
                  role="tab"
                  aria-selected={idx === slideIndex}
                  className={`ryst-swatch-pill ${
                    idx === slideIndex ? 'active' : ''
                  }`}
                  onClick={() => setSlideIndex(idx)}
                >
                  <span
                    className="ryst-swatch-dot"
                    style={{ background: slide.swatch }}
                  />
                  <span>{slide.colorName}</span>
                </button>
              ))}
            </div>
          </div>

          <div
            className="hero-shoe-stage"
            style={{
              transform: `translate3d(${dragOffset * 0.45}px, 0, 0)`
            }}
          >
            <div
              key={activeSlide.id}
              className="card"
              style={{
                '--card-gradient': activeSlide.cardGradient,
                '--card-footer-bg': activeSlide.cardFooterBg,
                transform: `rotateX(${cardTilt.rx}deg) rotateY(${cardTilt.ry}deg)`
              }}
              onMouseMove={handle3DCardMouseMove}
              onMouseLeave={handle3DCardMouseLeave}
            >
              <div
                className="product"
                onClick={() => openQuickView(activeSlide.featuredShoe)}
              >
                <span className="number">{slideNumberLabel}</span>
                <span className="sneakers-watermark">{activeSlide.brandTag}</span>
                <TransparentShoeImg
                  src={activeSlide.heroShoeImage}
                  alt={activeSlide.cardTitle}
                  className="shoe-3d-img"
                />
                <span className="product-price-pill">
                  ${activeSlide.featuredShoe.price}
                </span>
              </div>

              <div
                className="card-footer-bar"
                onClick={() => openQuickView(activeSlide.featuredShoe)}
              >
                {activeSlide.cardTitle}
              </div>
            </div>
          </div>

          <div className="ryst-hero-right">
            <div className="hero-sale-floating-card">
              <div
                className="hero-sale-img-box"
                onClick={() => openQuickView(activeSlide.featuredShoe)}
              >
                <span className="sale-yellow-tag">SALE</span>
                <TransparentShoeImg
                  src={activeSlide.heroShoeImage}
                  alt={activeSlide.featuredShoe.name}
                  className="hero-sale-cutout-img"
                />
              </div>

              <div className="hero-sale-info">
                <div>
                  <div className="hero-sale-brand-tag">
                    {activeSlide.featuredShoe.brand}
                  </div>
                  <div className="hero-sale-name">
                    {activeSlide.featuredShoe.name}
                  </div>
                  <div className="hero-sale-prices">
                    <strong>${activeSlide.featuredShoe.price}.00</strong>
                    {activeSlide.featuredShoe.originalPrice && (
                      <span>${activeSlide.featuredShoe.originalPrice}.00</span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  className="hero-sale-add-btn"
                  onClick={() => {
                    add(activeSlide.featuredShoe);
                    setShowCart(true);
                  }}
                >
                  + ADD TO BAG
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* RISING CONTENT SHEET THAT SLIDES OVER THE STICKY HERO */}
      <div className="scroll-stack-sheet">
        <section id="bestsellers-section" className="ryst-section">
          <div className="ryst-container">
            <div className="ryst-section-header scroll-up-item" data-scroll-up>
              <h2 className="ryst-eyebrow-heading">BEST SELLERS</h2>
              <button
                type="button"
                className="ryst-text-link"
                onClick={() => scrollToSection('catalog-storefront', 'All')}
              >
                VIEW ALL →
              </button>
            </div>

            <div className="bestsellers-grid">
              {BEST_SELLERS.map((item, idx) => {
                const isFav = favorites.includes(item.id);
                return (
                  <article
                    key={item.id}
                    className="bs-card scroll-up-item"
                    data-scroll-up
                    style={{ '--scroll-delay': `${idx * 70}ms` }}
                  >
                    <div
                      className="bs-media"
                      onClick={() => openQuickView(item)}
                    >
                      {item.badge && <span className="bs-tag">{item.badge}</span>}
                      <button
                        type="button"
                        className={`bs-heart-btn ${isFav ? 'active' : ''}`}
                        aria-label="Save item"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(item.id);
                        }}
                      >
                        {isFav ? '♥' : '♡'}
                      </button>
                      <img src={item.image} alt={item.name} loading="lazy" />
                      <button
                        type="button"
                        className="bs-quick-add"
                        onClick={(e) => {
                          e.stopPropagation();
                          add(item);
                          setShowCart(true);
                        }}
                      >
                        + QUICK ADD
                      </button>
                    </div>

                    <div className="bs-meta">
                      <div className="bs-brand-eyebrow">{item.brand}</div>
                      <h3 onClick={() => openQuickView(item)}>{item.name}</h3>
                      <div className="bs-price-row">
                        <strong>${item.price}.00</strong>
                        {item.originalPrice && (
                          <del>${item.originalPrice}.00</del>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section id="kids-promo-section" className="kids-banner">
          <div className="kids-banner-inner">
            <div className="kids-banner-left scroll-up-item" data-scroll-up>
              <h2>20% Off Kids Styles</h2>
              <p>
                Exclusive youth sizing from Nike, Adidas, and On Cloud with
                code <strong>STRIDE20</strong>.
              </p>
              <button
                type="button"
                className="ryst-pill-btn dark"
                onClick={() =>
                  scrollToSection('catalog-storefront', 'Kids Collection')
                }
              >
                SHOP KIDS
              </button>
            </div>

            <div className="kids-banner-center scroll-up-item" data-scroll-up>
              <img
                src="https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=900&q=85"
                alt="Nike Air Force 1 Pastel Kids"
                className="kids-pair-img"
              />
            </div>

            <div className="kids-banner-right scroll-up-item" data-scroll-up>
              <div
                className="kids-mini-sale-card"
                onClick={() => openQuickView(BEST_SELLERS[3])}
              >
                <span className="sale-yellow-tag">-20%</span>
                <img
                  src="https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=85"
                  alt="Kids Crimson Runner"
                />
                <div className="kids-mini-caption">
                  <span>YOUTH EDITION</span>
                  <span>$64.00</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="ryst-marquee" aria-hidden="true">
          <div className="ryst-marquee-track">
            {[0, 1].map((loop) => (
              <div key={loop} style={{ display: 'inline-flex' }}>
                <span className="ryst-marquee-item">
                  100% AUTHENTIC NIKE, ADIDAS &amp; ON CLOUD
                  <span className="ryst-marquee-star">✦</span>
                </span>
                <span className="ryst-marquee-item">
                  REAL USER-TO-USER SELLER MESSAGING
                  <span className="ryst-marquee-star">✦</span>
                </span>
                <span className="ryst-marquee-item">
                  FREE SHIPPING ON ORDERS OVER $150
                  <span className="ryst-marquee-star">✦</span>
                </span>
                <span className="ryst-marquee-item">
                  USE CODE STRIDE20 FOR 20% OFF
                  <span className="ryst-marquee-star">✦</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <section className="ryst-section">
          <div className="ryst-container">
            <div className="ryst-section-header scroll-up-item" data-scroll-up>
              <h2 className="ryst-eyebrow-heading">SHOP BY COLLECTION</h2>
            </div>

            <div className="collections-grid">
              {COLLECTIONS.map((col, idx) => (
                <div
                  key={col.id}
                  className="collection-card scroll-up-item"
                  data-scroll-up
                  style={{ '--scroll-delay': `${idx * 80}ms` }}
                  onClick={() => scrollToSection('catalog-storefront', col.id)}
                >
                  <img src={col.image} alt={col.label} loading="lazy" />
                  <button type="button" className="collection-pill-btn">
                    {col.label} →
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="sustainability-section" className="sustain-banner">
          <div className="sustain-banner-inner">
            <div className="sustain-left scroll-up-item" data-scroll-up>
              <h2>Committed to Sustainability</h2>
              <p>
                Featuring recycled Primeknit uppers, bio-based EVA midsoles, and
                verified circular footwear programs across our partner brands.
              </p>
            </div>

            <div className="sustain-center scroll-up-item" data-scroll-up>
              <img
                src="https://images.unsplash.com/photo-1587563871167-1ee9c731aefb?auto=format&fit=crop&w=900&q=85"
                alt="Recycled Trail Runner"
                className="sustain-shoe-img"
              />
            </div>

            <div className="sustain-right scroll-up-item" data-scroll-up>
              <p className="sustain-note">
                Every pair ships in 100% post-consumer recycled packaging with
                verified authenticity documentation.
              </p>
              <button
                type="button"
                className="sustain-read-btn"
                onClick={() => setShowSustainabilityModal(true)}
              >
                READ IMPACT REPORT
              </button>
            </div>
          </div>
        </section>

        <section id="catalog-storefront" className="storefront">
          <div className="storefront-container">
            {listingToast && (
              <div className="listing-toast-banner" role="status">
                <span>✓ {listingToast}</span>
                <button
                  type="button"
                  onClick={() => setListingToast('')}
                  aria-label="Dismiss notification"
                >
                  ✕
                </button>
              </div>
            )}

            <div className="catalog-topbar">
              <div>
                <h2 className="catalog-heading">
                  {wishlistOnly
                    ? 'Saved Wishlist'
                    : category === 'All'
                    ? 'All Verified Sneakers'
                    : category}
                </h2>
                <p className="catalog-count">
                  Showing {shown.length} of {allProducts.length} styles
                  {userListings.length > 0 &&
                    ` (${userListings.length} community seller ${
                      userListings.length === 1 ? 'listing' : 'listings'
                    })`}
                </p>
              </div>

              <div className="catalog-right-controls">
                <button
                  type="button"
                  className="catalog-sell-cta"
                  onClick={openSellPortal}
                >
                  + List Your Sneakers
                </button>

                <div className="sort-control">
                  <span className="sort-label">SORT BY</span>
                  <div className="sort-select-wrap">
                    <select
                      className="sort-select"
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      aria-label="Sort products"
                    >
                      <option value="featured">Featured</option>
                      <option value="price-asc">Price: Low to High</option>
                      <option value="price-desc">Price: High to Low</option>
                      <option value="rating">Highest Rated</option>
                      <option value="reviews">Most Reviewed</option>
                    </select>
                    <span className="sort-chevron">▾</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="storefront-layout">
              <aside className="filter-sidebar">
                <div className="filter-header">
                  <h2>FILTERS</h2>
                  {hasActiveFilters && (
                    <button
                      type="button"
                      className="reset-btn"
                      onClick={resetFilters}
                    >
                      Reset all
                    </button>
                  )}
                </div>

                <div className="filter-group">
                  <div className="wishlist-row">
                    <div>
                      <div className="wishlist-title">Saved Items Only</div>
                      <div className="wishlist-sub">
                        {favorites.length} saved in wishlist
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={wishlistOnly}
                      className={`toggle-switch ${wishlistOnly ? 'on' : ''}`}
                      onClick={() => setWishlistOnly((prev) => !prev)}
                    >
                      <span className="toggle-knob" />
                    </button>
                  </div>
                </div>

                <div className="filter-group">
                  <div className="filter-label">CATEGORY</div>
                  <ul className="category-list">
                    {CATEGORIES.map((cat) => {
                      const selected = category === cat;
                      return (
                        <li key={cat}>
                          <button
                            type="button"
                            className={`category-option ${
                              selected ? 'selected' : ''
                            }`}
                            onClick={() => setCategory(cat)}
                          >
                            <span className="radio-circle">
                              {selected && <span className="radio-dot" />}
                            </span>
                            <span className="category-name">{cat}</span>
                            <span className="category-count">
                              {categoryCounts[cat] || 0}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="filter-group">
                  <div className="brands-header">
                    <div className="filter-label">BRANDS</div>
                    <span className="brands-total">{brands.length}</span>
                  </div>
                  <ul className="brand-list">
                    {brands.map(({ name, count }) => {
                      const checked = selectedBrands.includes(name);
                      return (
                        <li key={name}>
                          <button
                            type="button"
                            className={`brand-option ${
                              checked ? 'selected' : ''
                            }`}
                            onClick={() => toggleBrand(name)}
                          >
                            <span className="checkbox-box">
                              {checked ? '✓' : ''}
                            </span>
                            <span className="brand-name">{name}</span>
                            <span className="brand-count">{count}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </aside>

              <div>
                {shown.length === 0 ? (
                  <div className="empty-state">
                    <h3>No sneakers match your current filters</h3>
                    <p>
                      Try clearing your search or resetting brand and category
                      filters.
                    </p>
                    <button type="button" onClick={resetFilters}>
                      Reset Filters
                    </button>
                  </div>
                ) : (
                  <div className="products-grid">
                    {shown.map((product) => {
                      const isFav = favorites.includes(product.id);
                      const seller = getProductSeller(product);
                      const canRemoveListing = isListingOwner(
                        product,
                        currentUser
                      );
                      return (
                        <article key={product.id} className="product-card">
                          <div
                            className="card-media"
                            onClick={() => openQuickView(product)}
                          >
                            <div className="card-badges">
                              {product.discountTag && (
                                <span className="badge badge-discount">
                                  {product.discountTag}
                                </span>
                              )}
                              {product.badge && (
                                <span
                                  className={`badge ${
                                    product.isUserListing
                                      ? 'badge-seller'
                                      : 'badge-tag'
                                  }`}
                                >
                                  {product.badge}
                                </span>
                              )}
                            </div>

                            <button
                              type="button"
                              className={`heart-btn ${isFav ? 'active' : ''}`}
                              aria-label="Save item"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleFavorite(product.id);
                              }}
                            >
                              {isFav ? '♥' : '♡'}
                            </button>

                            <img
                              src={product.image}
                              alt={product.name}
                              loading="lazy"
                            />

                            <button
                              type="button"
                              className="quick-view-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                openQuickView(product);
                              }}
                            >
                              <span>Quick View &amp; Specs</span>
                            </button>
                          </div>

                          <div className="product-info">
                            <div className="meta-row">
                              <span className="brand-pill">{product.brand}</span>
                              <span className="cat-tag">{product.category}</span>
                            </div>

                            <h3 onClick={() => openQuickView(product)}>
                              {product.name}
                            </h3>
                            <p className="subtitle">{product.subtitle}</p>

                            <div
                              className="card-seller-strip"
                              onClick={() => openQuickView(product)}
                            >
                              {seller.avatar ? (
                                <img
                                  src={seller.avatar}
                                  alt={seller.name}
                                  className="seller-mini-avatar"
                                />
                              ) : (
                                <span className="seller-mini-initials">
                                  {getInitials(seller.name)}
                                </span>
                              )}
                              <div className="seller-mini-info">
                                <span className="seller-mini-name">
                                  {seller.name}
                                </span>
                                <span className="seller-mini-loc">
                                  📍 {seller.location}
                                </span>
                              </div>

                              <button
                                type="button"
                                className="seller-chat-chip-btn"
                                title={
                                  canRemoveListing
                                    ? 'View buyer messages'
                                    : `Message ${seller.name}`
                                }
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openChatWithSeller(product);
                                }}
                              >
                                {canRemoveListing ? '💬 Inbox' : '💬 Chat'}
                              </button>

                              {canRemoveListing && (
                                <button
                                  type="button"
                                  className="seller-remove-listing-btn"
                                  title="Delete your listing"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteUserListing(product.id);
                                  }}
                                >
                                  ✕
                                </button>
                              )}
                            </div>

                            <div className="card-bottom">
                              <div className="rating-price-row">
                                <div className="rating">
                                  <span className="stars">★★★★★</span>
                                  <strong>{product.rating}</strong>
                                  <span className="reviews">
                                    ({product.reviews})
                                  </span>
                                </div>

                                <div className="price-box">
                                  {product.originalPrice && (
                                    <span className="orig-price">
                                      ${product.originalPrice}
                                    </span>
                                  )}
                                  <span className="curr-price">
                                    ${product.price}
                                  </span>
                                </div>
                              </div>

                              <button
                                type="button"
                                className="add-btn"
                                onClick={() => {
                                  add(product);
                                  setShowCart(true);
                                }}
                              >
                                + Add to Bag
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="reviews-section">
          <div className="ryst-container reviews-layout">
            <div>
              <h2 className="ryst-eyebrow-heading">VERIFIED BUYERS</h2>
              <p className="reviews-sub">
                Every pair is carefully inspected for quality and authenticity
                before dispatch.
              </p>
            </div>

            <div className="reviews-right">
              <button
                type="button"
                className="review-arrow-btn"
                aria-label="Previous review"
                onClick={() =>
                  setReviewOffset(
                    (prev) =>
                      (prev - 1 + CUSTOMER_REVIEWS.length) %
                      CUSTOMER_REVIEWS.length
                  )
                }
              >
                ‹
              </button>

              <div className="reviews-cards-row">
                {visibleReviews.map((rev) => (
                  <article
                    key={rev.id}
                    className={`review-card ${rev.theme}`}
                  >
                    <div>
                      <h3>{rev.title}</h3>
                      <p>{rev.body}</p>
                    </div>
                    <div className="review-author">— {rev.author}</div>
                  </article>
                ))}
              </div>

              <button
                type="button"
                className="review-arrow-btn"
                aria-label="Next review"
                onClick={() =>
                  setReviewOffset(
                    (prev) => (prev + 1) % CUSTOMER_REVIEWS.length
                  )
                }
              >
                ›
              </button>
            </div>
          </div>
        </section>

        <footer className="ryst-footer">
          <div className="ryst-container">
            <div className="ryst-footer-grid">
              <div>
                <div className="ryst-footer-logo">
                  SoleSyndicate<span>.</span>
                </div>
                <p className="ryst-footer-tagline">
                  Curated Nike, Adidas, and On Cloud footwear engineered for
                  everyday comfort, performance, and community peer-to-peer
                  drops.
                </p>

                <div className="ryst-footer-links">
                  <div>
                    <h4>COLLECTIONS</h4>
                    <button
                      type="button"
                      onClick={() =>
                        scrollToSection(
                          'catalog-storefront',
                          'Performance Series'
                        )
                      }
                    >
                      Performance Series
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        scrollToSection('catalog-storefront', 'Limited Edition')
                      }
                    >
                      Limited Edition
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        scrollToSection('catalog-storefront', 'Kids Collection')
                      }
                    >
                      Kids Collection
                    </button>
                  </div>

                  <div>
                    <h4>COMMUNITY</h4>
                    <button type="button" onClick={openSellPortal}>
                      + Sell Your Sneakers
                    </button>
                    <button type="button" onClick={openMessagesInbox}>
                      💬 Seller Messages
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        currentUser
                          ? setShowAccountHub(true)
                          : setAuthModalMode('login')
                      }
                    >
                      {currentUser ? '👤 My Gmail Account' : '🔐 Sign In / Register'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="ryst-newsletter-card">
                <h3>
                  Get 20% off your first verified pair &amp; early drop alerts.
                </h3>

                {newsletterSubmitted ? (
                  <div className="newsletter-success">
                    You&apos;re in! Use code <strong>STRIDE20</strong> at
                    checkout for 20% off your order.
                  </div>
                ) : (
                  <form onSubmit={handleNewsletterSubmit}>
                    <label
                      htmlFor="footer-email"
                      className="newsletter-label"
                    >
                      EMAIL ADDRESS
                    </label>
                    <div className="newsletter-input-row">
                      <input
                        id="footer-email"
                        type="email"
                        required
                        value={newsletterEmail}
                        onChange={(e) => setNewsletterEmail(e.target.value)}
                        placeholder="you@gmail.com"
                      />
                      <button type="submit">JOIN</button>
                    </div>

                    <label className="newsletter-checkbox">
                      <input
                        type="checkbox"
                        checked={newsletterConsent}
                        onChange={(e) =>
                          setNewsletterConsent(e.target.checked)
                        }
                      />
                      <span>Send me restock &amp; limited release alerts</span>
                    </label>
                  </form>
                )}
              </div>
            </div>

            <div className="ryst-footer-bottom">
              <span>© {new Date().getFullYear()} SoleSyndicate Storefront</span>
              <span>Authentic Nike, Adidas &amp; On Cloud Marketplace</span>
            </div>
          </div>
        </footer>
      </div>

      {/* REAL USER-TO-USER CHAT DRAWER (NO AUTOMATIC BOT REPLIES) */}
      {isChatDrawerOpen && currentUser && (
        <div
          className="bag-backdrop"
          onClick={() => setIsChatDrawerOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Direct user-to-user messages"
        >
          <aside
            className="chat-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chat-header">
              <div className="chat-seller-identity">
                <div className="chat-seller-initials">
                  {getInitials(chatCounterpartName)}
                </div>

                <div>
                  <div className="chat-seller-name-row">
                    <h3>{chatCounterpartName}</h3>
                    <span className="chat-online-dot" title="Live sync active" />
                  </div>
                  <div className="chat-seller-sub">
                    {chatCounterpartRoleLabel} • Live Direct Chat
                  </div>
                </div>
              </div>

              <div className="chat-header-actions">
                <button
                  type="button"
                  className="bag-close-btn"
                  aria-label="Close chat"
                  onClick={() => setIsChatDrawerOpen(false)}
                >
                  ✕
                </button>
              </div>
            </div>

            {activeThreadsList.length > 0 && (
              <div className="chat-threads-bar">
                {activeThreadsList.map((thread) => {
                  const active = thread.threadKey === activeThreadKey;
                  const counterpart =
                    thread.sellerEmail === myEmailLower
                      ? `${thread.buyerName} (Buyer)`
                      : `${thread.sellerName} (Seller)`;
                  return (
                    <div
                      key={thread.threadKey}
                      className={`chat-thread-pill ${active ? 'active' : ''}`}
                    >
                      <button
                        type="button"
                        className="chat-thread-select"
                        onClick={() => {
                          setWaitingSellerProduct(null);
                          setActiveThreadKey(thread.threadKey);
                        }}
                      >
                        <span>{counterpart}</span>
                        <small>• {thread.listingName}</small>
                      </button>
                      <button
                        type="button"
                        className="chat-thread-remove"
                        aria-label={`Remove chat with ${counterpart}`}
                        title={`Remove chat with ${counterpart}`}
                        onClick={() => deleteChatThread(thread.threadKey)}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {activeThreadProductObj && (
              <div className="chat-product-bar">
                <img
                  src={activeThreadProductObj.image}
                  alt={activeThreadProductObj.name}
                  className="chat-product-thumb"
                />
                <div className="chat-product-info">
                  <div className="chat-product-title">
                    {activeThreadProductObj.name}
                  </div>
                  <div className="chat-product-price">
                    ${activeThreadProductObj.price}.00
                  </div>
                </div>
                {!isCurrentUserSellerInThread && !waitingSellerProduct && (
                  <button
                    type="button"
                    className="chat-product-bag-btn"
                    onClick={() => {
                      add(activeThreadProductObj);
                      setIsChatDrawerOpen(false);
                      setShowCart(true);
                    }}
                  >
                    + Bag
                  </button>
                )}
              </div>
            )}

            <div className="chat-messages-scroll">
              {!activeThread ? (
                <div className="bag-empty" style={{ padding: '40px 20px' }}>
                  <div className="bag-empty-icon">💬</div>
                  <h3>
                    {waitingSellerProduct
                      ? 'No Buyer Messages Yet'
                      : 'No Conversations Yet'}
                  </h3>
                  <p>
                    {waitingSellerProduct
                      ? `When a buyer clicks Chat on "${waitingSellerProduct.name}", their message will appear here in real time so you can reply.`
                      : 'Click "💬 Chat" on any sneaker listing to message the seller directly.'}
                  </p>
                </div>
              ) : activeThread.messages.length === 0 ? (
                <div className="bag-empty" style={{ padding: '40px 20px' }}>
                  <div className="bag-empty-icon">✉️</div>
                  <h3>Message {chatCounterpartName}</h3>
                  <p>
                    Send a message below about{' '}
                    <strong>{activeThread.listingName}</strong>. Only{' '}
                    {chatCounterpartName} will reply when online.
                  </p>
                </div>
              ) : (
                activeThread.messages.map((msg) => {
                  const isMine = msg.senderEmail === myEmailLower;
                  return (
                    <div
                      key={msg.id}
                      className={`chat-bubble-row ${
                        isMine ? 'buyer' : 'seller'
                      }`}
                    >
                      <div className="chat-bubble">
                        {!isMine && (
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              marginBottom: 3,
                              opacity: 0.75
                            }}
                          >
                            {msg.senderName}
                          </div>
                        )}
                        <p>{msg.text}</p>
                        <span className="chat-time">{msg.time}</span>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={chatMessagesEndRef} />
            </div>

            {activeThread && !isCurrentUserSellerInThread && (
              <div className="chat-quick-prompts">
                {QUICK_CHAT_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="chat-prompt-chip"
                    onClick={() => sendChatMessage(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}

            {activeThread && (
              <form
                className="chat-input-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendChatMessage(chatInput);
                }}
              >
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={`Write a message to ${chatCounterpartName}...`}
                  aria-label="Type your message"
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim() || isSendingMessage}
                >
                  {isSendingMessage ? '...' : 'Send'}
                </button>
              </form>
            )}
          </aside>
        </div>
      )}

      {/* SELL / LIST SNEAKERS MODAL */}
      {showSellModal && currentUser && (
        <div
          className="qv-backdrop"
          onClick={() => setShowSellModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sell-modal-title"
        >
          <div className="sell-modal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="qv-close"
              aria-label="Close listing form"
              onClick={() => setShowSellModal(false)}
            >
              ✕
            </button>

            <div className="sell-modal-header">
              <span className="sell-modal-eyebrow">
                SOLESYNDICATE SELLER PORTAL
              </span>
              <h2 id="sell-modal-title">List Your Sneakers for Sale</h2>
              <p>
                Visible to all shoppers—only your account ({currentUser.email})
                can delete this listing.
              </p>
            </div>

            <div className="sell-connected-account">
              <div className="sell-connected-left">
                {currentUser.avatar ? (
                  <img
                    src={currentUser.avatar}
                    alt={currentUser.name}
                    className="sell-connected-avatar"
                  />
                ) : (
                  <div className="seller-mini-initials">
                    {getInitials(currentUser.name)}
                  </div>
                )}
                <div>
                  <div className="sell-connected-name">
                    Listing as <strong>{currentUser.name}</strong>
                  </div>
                  <div className="sell-connected-meta">
                    📍 {currentUser.location || 'Location not set'} •{' '}
                    {currentUser.email}
                  </div>
                </div>
              </div>

              <button
                type="button"
                className="sell-edit-account-btn"
                onClick={() => {
                  setShowSellModal(false);
                  setShowAccountHub(true);
                }}
              >
                Edit Profile
              </button>
            </div>

            <form className="sell-form" onSubmit={handlePublishListing}>
              <div className="sell-section-card">
                <div className="sell-section-title">
                  <span>SNEAKER LISTING DETAILS</span>
                </div>

                <div className="sell-row-2">
                  <div className="sell-field">
                    <label htmlFor="shoe-brand">BRAND *</label>
                    <select
                      id="shoe-brand"
                      value={shoeBrand}
                      onChange={(e) => setShoeBrand(e.target.value)}
                    >
                      <option value="NIKE">NIKE</option>
                      <option value="ADIDAS">ADIDAS</option>
                      <option value="ON CLOUD">ON CLOUD</option>
                      <option value="OTHER">Other Brand...</option>
                    </select>
                  </div>

                  <div className="sell-field">
                    <label htmlFor="shoe-category">COLLECTION *</label>
                    <select
                      id="shoe-category"
                      value={shoeCategory}
                      onChange={(e) => setShoeCategory(e.target.value)}
                    >
                      <option value="Limited Edition">Limited Edition</option>
                      <option value="Performance Series">
                        Performance Series
                      </option>
                      <option value="Kids Collection">Kids Collection</option>
                    </select>
                  </div>
                </div>

                {shoeBrand === 'OTHER' && (
                  <div className="sell-field">
                    <label htmlFor="custom-brand">ENTER BRAND NAME *</label>
                    <input
                      id="custom-brand"
                      type="text"
                      required
                      value={customBrand}
                      onChange={(e) => setCustomBrand(e.target.value)}
                      placeholder="e.g. New Balance, Jordan, ASICS"
                    />
                  </div>
                )}

                <div className="sell-field">
                  <label htmlFor="shoe-model">SNEAKER MODEL NAME *</label>
                  <input
                    id="shoe-model"
                    type="text"
                    required
                    value={shoeName}
                    onChange={(e) => setShoeName(e.target.value)}
                    placeholder="e.g. Nike Dunk Low Retro Panda"
                  />
                </div>

                <div className="sell-row-2">
                  <div className="sell-field">
                    <label htmlFor="shoe-price">ASKING PRICE (USD) *</label>
                    <input
                      id="shoe-price"
                      type="number"
                      min="1"
                      step="1"
                      required
                      value={shoePrice}
                      onChange={(e) => setShoePrice(e.target.value)}
                      placeholder="145"
                    />
                  </div>

                  <div className="sell-field">
                    <label htmlFor="shoe-orig-price">
                      RETAIL PRICE (OPTIONAL)
                    </label>
                    <input
                      id="shoe-orig-price"
                      type="number"
                      min="1"
                      step="1"
                      value={shoeOriginalPrice}
                      onChange={(e) => setShoeOriginalPrice(e.target.value)}
                      placeholder="180"
                    />
                  </div>
                </div>

                <div className="sell-field">
                  <label htmlFor="shoe-condition">CONDITION / TAGLINE</label>
                  <input
                    id="shoe-condition"
                    type="text"
                    value={shoeCondition}
                    onChange={(e) => setShoeCondition(e.target.value)}
                    placeholder="Brand New Deadstock • Original Box"
                  />
                </div>

                <div className="sell-field">
                  <label>AVAILABLE SIZES *</label>
                  <div className="sell-size-pills">
                    {AVAILABLE_SHOE_SIZES.map((sz) => {
                      const active = shoeSizes.includes(sz);
                      return (
                        <button
                          key={sz}
                          type="button"
                          className={`sell-size-pill ${
                            active ? 'active' : ''
                          }`}
                          onClick={() => toggleShoeSize(sz)}
                        >
                          {sz}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="sell-field">
                  <label>SNEAKER PHOTO (UPLOADS TO SUPABASE STORAGE)</label>
                  <div className="sell-photo-row">
                    <label className="sell-upload-pill">
                      📷 Upload Shoe Photo
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleShoePhotoUpload}
                        hidden
                      />
                    </label>
                    <input
                      type="url"
                      value={shoeImageUrlInput}
                      onChange={(e) => {
                        setShoeImageUrlInput(e.target.value);
                        setShoeImage('');
                        setShoeImageFile(null);
                      }}
                      placeholder="Or paste image URL..."
                    />
                  </div>

                  {(shoeImage || shoeImageUrlInput) && (
                    <div className="sell-shoe-preview-box">
                      <img
                        src={shoeImage || shoeImageUrlInput}
                        alt="Sneaker preview"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setShoeImage('');
                          setShoeImageFile(null);
                          setShoeImageUrlInput('');
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>

                <div className="sell-field">
                  <label htmlFor="shoe-desc">DESCRIPTION</label>
                  <textarea
                    id="shoe-desc"
                    rows={2}
                    value={shoeDescription}
                    onChange={(e) => setShoeDescription(e.target.value)}
                    placeholder="Colorway details, box condition, or sizing fit notes..."
                  />
                </div>
              </div>

              {sellFormError && (
                <div className="sell-form-error">{sellFormError}</div>
              )}

              <div className="sell-modal-footer">
                <button
                  type="button"
                  className="sell-cancel-btn"
                  disabled={isPublishing}
                  onClick={() => setShowSellModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="sell-submit-btn"
                  disabled={isPublishing}
                >
                  {isPublishing
                    ? 'Uploading Image & Saving to Supabase...'
                    : 'Publish Listing to SoleSyndicate →'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* QUICK VIEW & SPECS MODAL */}
      {quickViewProduct && (
        <div
          className="qv-backdrop"
          onClick={closeQuickView}
          role="dialog"
          aria-modal="true"
        >
          <div className="qv-modal" onClick={(e) => e.stopPropagation()}>
            <div className="qv-media">
              <div className="qv-badges">
                {quickViewProduct.discountTag && (
                  <span className="badge badge-discount">
                    {quickViewProduct.discountTag}
                  </span>
                )}
                {quickViewProduct.badge && (
                  <span
                    className={`badge ${
                      quickViewProduct.isUserListing
                        ? 'badge-seller'
                        : 'badge-tag'
                    }`}
                  >
                    {quickViewProduct.badge}
                  </span>
                )}
              </div>
              <img
                src={quickViewProduct.image}
                alt={quickViewProduct.name}
              />
            </div>

            <div className="qv-body">
              <button
                type="button"
                className="qv-close"
                aria-label="Close modal"
                onClick={closeQuickView}
              >
                ✕
              </button>

              <div className="qv-meta">
                <span className="qv-brand">{quickViewProduct.brand}</span>
                <span className="qv-dot">•</span>
                <span className="qv-cat">{quickViewProduct.category}</span>
              </div>

              <h2 className="qv-title">{quickViewProduct.name}</h2>
              <p className="qv-subtitle">{quickViewProduct.subtitle}</p>

              {(() => {
                const qvSeller = getProductSeller(quickViewProduct);
                const canDeleteQv = isListingOwner(
                  quickViewProduct,
                  currentUser
                );
                return (
                  <div className="qv-seller-card">
                    {qvSeller.avatar ? (
                      <img
                        src={qvSeller.avatar}
                        alt={qvSeller.name}
                        className="qv-seller-avatar"
                      />
                    ) : (
                      <div className="qv-seller-initials">
                        {getInitials(qvSeller.name)}
                      </div>
                    )}

                    <div className="qv-seller-details">
                      <div className="qv-seller-top">
                        <strong>{qvSeller.name}</strong>
                        <span className="qv-verified-seller-pill">
                          VERIFIED SELLER
                        </span>
                      </div>
                      <div className="qv-seller-location">
                        📍 {qvSeller.location}
                        {qvSeller.listedAt && ` • Listed ${qvSeller.listedAt}`}
                      </div>
                      {qvSeller.bio && (
                        <p className="qv-seller-bio">{qvSeller.bio}</p>
                      )}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        flexShrink: 0
                      }}
                    >
                      <button
                        type="button"
                        className="qv-chat-seller-btn"
                        onClick={() => openChatWithSeller(quickViewProduct)}
                      >
                        {canDeleteQv ? '💬 Inbox' : '💬 Chat'}
                      </button>

                      {canDeleteQv && (
                        <button
                          type="button"
                          className="account-signout-btn"
                          style={{ padding: '6px 10px', fontSize: 11 }}
                          onClick={() =>
                            handleDeleteUserListing(quickViewProduct.id)
                          }
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}

              <div className="qv-rating-price">
                <div className="rating">
                  <span className="stars">★★★★★</span>
                  <strong>{quickViewProduct.rating || 4.9}</strong>
                  <span className="reviews">
                    ({quickViewProduct.reviews || 120} reviews)
                  </span>
                </div>

                <div className="price-box">
                  {quickViewProduct.originalPrice && (
                    <span className="orig-price">
                      ${quickViewProduct.originalPrice}
                    </span>
                  )}
                  <span className="qv-price">${quickViewProduct.price}</span>
                </div>
              </div>

              <p className="qv-description">
                {quickViewProduct.description}
              </p>

              {quickViewProduct.specs && (
                <div className="qv-specs">
                  <div className="qv-section-label">KEY SPECIFICATIONS</div>
                  <ul>
                    {quickViewProduct.specs.map((spec, idx) => (
                      <li key={idx}>
                        <span className="check-icon">✓</span>
                        <span>{spec}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {quickViewProduct.options && (
                <div className="qv-options">
                  <div className="qv-options-head">
                    <span className="qv-section-label">
                      {getOptionTypeName(quickViewProduct.optionLabel)}
                    </span>
                    <span className="qv-selected-val">{selectedOption}</span>
                  </div>

                  <div className="qv-option-pills">
                    {quickViewProduct.options.map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        className={`qv-pill ${
                          selectedOption === opt ? 'active' : ''
                        }`}
                        onClick={() => setSelectedOption(opt)}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="qv-actions">
                <div className="qty-control">
                  <button
                    type="button"
                    aria-label="Decrease quantity"
                    onClick={() => setModalQty((q) => Math.max(1, q - 1))}
                  >
                    −
                  </button>
                  <span>{modalQty}</span>
                  <button
                    type="button"
                    aria-label="Increase quantity"
                    onClick={() => setModalQty((q) => q + 1)}
                  >
                    +
                  </button>
                </div>

                <button
                  type="button"
                  className="qv-add-btn"
                  onClick={() => {
                    add(quickViewProduct, modalQty, selectedOption);
                    closeQuickView();
                    setShowCart(true);
                  }}
                >
                  Add to Bag — ${quickViewProduct.price * modalQty}
                </button>

                <button
                  type="button"
                  className={`qv-heart-btn ${
                    favorites.includes(quickViewProduct.id) ? 'active' : ''
                  }`}
                  aria-label="Save item"
                  onClick={() => toggleFavorite(quickViewProduct.id)}
                >
                  {favorites.includes(quickViewProduct.id) ? '♥' : '♡'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUSTAINABILITY IMPACT MODAL */}
      {showSustainabilityModal && (
        <div
          className="qv-backdrop"
          onClick={() => setShowSustainabilityModal(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="sustain-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="qv-close"
              aria-label="Close modal"
              onClick={() => setShowSustainabilityModal(false)}
            >
              ✕
            </button>
            <span className="sustain-modal-tag">2026 IMPACT REPORT</span>
            <h2>Circular Footwear Commitment</h2>
            <p>
              We partner directly with verified suppliers across Nike Move to
              Zero, Adidas End Plastic Waste, and On Cyclon programs.
            </p>
            <ul>
              <li>✓ 100% post-consumer recycled shipping cartons</li>
              <li>✓ Minimum 40% recycled polyester uppers on featured lines</li>
              <li>
                ✓ Peer-to-peer resale extends the lifecycle of authentic
                sneakers
              </li>
            </ul>
            <button
              type="button"
              className="ryst-pill-btn dark"
              onClick={() => setShowSustainabilityModal(false)}
            >
              GOT IT
            </button>
          </div>
        </div>
      )}

      {/* SHOPPING BAG SLIDE-OVER DRAWER */}
      {showCart && (
        <div
          className="bag-backdrop"
          onClick={() => setShowCart(false)}
          role="dialog"
          aria-modal="true"
        >
          <aside
            className="bag-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bag-header">
              <div className="bag-title-group">
                <h2>Shopping Bag</h2>
                <span className="bag-items-pill">{totalItems} items</span>
              </div>
              <button
                type="button"
                className="bag-close-btn"
                aria-label="Close bag"
                onClick={() => setShowCart(false)}
              >
                ✕
              </button>
            </div>

            <div className="bag-shipping-bar">
              <div className="bag-shipping-top">
                {freeShippingRemaining === 0 ? (
                  <span>🎉 You unlocked FREE Express Shipping!</span>
                ) : (
                  <span>
                    Add <strong>${formatMoney(freeShippingRemaining)}</strong>{' '}
                    more for FREE shipping
                  </span>
                )}
                <span>{Math.round(shippingProgressPct)}%</span>
              </div>
              <div className="bag-progress-track">
                <div
                  className="bag-progress-fill"
                  style={{ width: `${shippingProgressPct}%` }}
                />
              </div>
            </div>

            <div className="bag-items-scroll">
              {cart.length === 0 ? (
                <div className="bag-empty">
                  <div className="bag-empty-icon">👟</div>
                  <h3>Your bag is empty</h3>
                  <p>
                    Explore verified Nike, Adidas, and On Cloud sneakers to add
                    your first pair.
                  </p>
                  <button
                    type="button"
                    className="bag-continue-btn"
                    onClick={() => setShowCart(false)}
                  >
                    Continue Shopping
                  </button>
                </div>
              ) : (
                cart.map((item) => (
                  <div key={item.cartKey} className="bag-item-card">
                    <img
                      src={item.image}
                      alt={item.name}
                      className="bag-item-thumb"
                    />
                    <div className="bag-item-details">
                      <div className="bag-item-top">
                        <span className="bag-item-brand">{item.brand}</span>
                        <button
                          type="button"
                          className="bag-item-remove"
                          onClick={() => removeFromCart(item.cartKey)}
                        >
                          Remove
                        </button>
                      </div>

                      <h4 className="bag-item-name">{item.name}</h4>

                      {item.seller && (
                        <span className="bag-item-seller">
                          Seller: {item.seller.name} ({item.seller.location})
                        </span>
                      )}

                      {item.selectedOption && (
                        <span className="bag-item-variant">
                          {item.selectedOption}
                        </span>
                      )}

                      <div className="bag-item-bottom">
                        <div className="bag-qty-stepper">
                          <button
                            type="button"
                            onClick={() => updateCartQty(item.cartKey, -1)}
                          >
                            −
                          </button>
                          <span>{item.qty}</span>
                          <button
                            type="button"
                            onClick={() => updateCartQty(item.cartKey, 1)}
                          >
                            +
                          </button>
                        </div>

                        <strong>${formatMoney(item.price * item.qty)}</strong>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {cart.length > 0 && (
              <div className="bag-footer">
                <form className="bag-promo-form" onSubmit={handleApplyPromo}>
                  <input
                    type="text"
                    className="bag-promo-input"
                    value={promoInput}
                    onChange={(e) => setPromoInput(e.target.value)}
                    placeholder="Promo code (try STRIDE20)"
                  />
                  <button type="submit" className="bag-promo-apply">
                    Apply
                  </button>
                </form>

                {promoError && (
                  <div className="bag-promo-error">{promoError}</div>
                )}

                {appliedPromo && (
                  <div className="bag-promo-applied">
                    <span>Code {appliedPromo} applied (20% off)</span>
                    <button
                      type="button"
                      onClick={() => setAppliedPromo('')}
                    >
                      ✕
                    </button>
                  </div>
                )}

                <div className="bag-summary-rows">
                  <div className="bag-summary-row">
                    <span>Subtotal</span>
                    <span>${formatMoney(subtotal)}</span>
                  </div>

                  {promoDiscount > 0 && (
                    <div className="bag-summary-row discount">
                      <span>Discount (20%)</span>
                      <span>−${formatMoney(promoDiscount)}</span>
                    </div>
                  )}

                  <div className="bag-summary-row">
                    <span>Shipping</span>
                    <span className={shippingFee === 0 ? 'free-ship' : ''}>
                      {shippingFee === 0
                        ? 'FREE'
                        : `$${formatMoney(shippingFee)}`}
                    </span>
                  </div>
                </div>

                <div className="bag-total-row">
                  <span>Estimated Total</span>
                  <span>${formatMoney(grandTotal)}</span>
                </div>

                <button
                  type="button"
                  className="bag-checkout-btn"
                  onClick={() => {
                    if (currentUser) {
                      const newOrder = {
                        id: Math.floor(100000 + Math.random() * 900000),
                        userEmail: currentUser.email,
                        date: new Date().toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric'
                        }),
                        total: formatMoney(grandTotal),
                        items: cart
                      };
                      setOrders((prev) => [newOrder, ...prev]);
                    }

                    alert(
                      `Order confirmed! Total: $${formatMoney(grandTotal)}.${
                        currentUser ? ` Receipt sent to ${currentUser.email}.` : ''
                      } Thank you for shopping at SoleSyndicate.`
                    );
                    setCart([]);
                    setAppliedPromo('');
                    setShowCart(false);
                  }}
                >
                  <span>Proceed to Checkout</span>
                  <span>→</span>
                </button>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* GMAIL / GOOGLE API LOGIN & REGISTRATION MODAL */}
      {authModalMode && (
        <AuthModal
          initialMode={authModalMode}
          registeredUsers={registeredUsers}
          onClose={() => {
            setAuthModalMode(null);
            setPendingOpenSell(false);
            setPendingChatProduct(null);
          }}
          onCompleteAuth={handleCompleteAuth}
        />
      )}

      {/* LOGGED-IN GMAIL MEMBER ACCOUNT HUB */}
      {showAccountHub && currentUser && (
        <AccountHubModal
          user={currentUser}
          userListings={userListings.filter((item) =>
            isListingOwner(item, currentUser)
          )}
          orders={orders}
          favoritesCount={favorites.length}
          onClose={() => setShowAccountHub(false)}
          onUpdateProfile={handleUpdateUserProfile}
          onDeleteListing={handleDeleteUserListing}
          onOpenSellModal={openSellPortal}
          onSignOut={handleSignOut}
        />
      )}
    </div>
  );
}