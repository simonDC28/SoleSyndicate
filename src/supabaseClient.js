import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const isSupabaseConfigured =
  Boolean(supabaseUrl) &&
  Boolean(supabaseAnonKey) &&
  !supabaseUrl.includes('YOUR_PROJECT_ID');

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

const BUCKET_NAME = 'sneaker-images';

function mapRowToProduct(row) {
  return {
    id: row.id,
    isUserListing: true,
    ownerEmail: row.owner_email,
    brand: row.brand,
    name: row.name,
    subtitle: row.subtitle || 'Community Verified Listing',
    description: row.description || '',
    specs: Array.isArray(row.specs) ? row.specs : [],
    optionLabel: row.option_label || 'SELECT SIZE',
    options: Array.isArray(row.options) ? row.options : ['US 9', 'US 10'],
    price: Number(row.price),
    originalPrice: row.original_price ? Number(row.original_price) : undefined,
    discountTag: row.discount_tag || undefined,
    badge: row.badge || 'SELLER LISTING',
    rating: Number(row.rating || 5.0),
    reviews: Number(row.reviews || 1),
    category: row.category,
    image: row.image,
    seller: {
      name: row.seller_name,
      location: row.seller_location,
      avatar: row.seller_avatar || '',
      bio:
        row.seller_bio ||
        'Verified SoleSyndicate community seller • Fast dispatch',
      listedAt: row.created_at
        ? new Date(row.created_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          })
        : 'Just now'
    }
  };
}

export async function uploadSneakerImageToSupabase(file) {
  if (!supabase || !file) return null;

  const ext = (file.name.split('.').pop() || 'jpg').replace(
    /[^a-zA-Z0-9]/g,
    ''
  );
  const filePath = `listings/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(filePath, file, {
      contentType: file.type || 'image/jpeg',
      upsert: false
    });

  if (uploadError) {
    throw new Error(`Image upload failed: ${uploadError.message}`);
  }

  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(filePath);
  return data.publicUrl;
}

export async function fetchListingsFromSupabase() {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load listings: ${error.message}`);
  }

  return (data || []).map(mapRowToProduct);
}

export async function createListingInSupabase(product) {
  if (!supabase) return product;

  const rowPayload = {
    brand: product.brand,
    name: product.name,
    subtitle: product.subtitle,
    description: product.description,
    specs: product.specs,
    option_label: product.optionLabel,
    options: product.options,
    price: product.price,
    original_price: product.originalPrice ?? null,
    discount_tag: product.discountTag ?? null,
    badge: product.badge || 'SELLER LISTING',
    rating: product.rating || 5.0,
    reviews: product.reviews || 1,
    category: product.category,
    image: product.image,
    owner_email: product.ownerEmail.trim().toLowerCase(),
    seller_name: product.seller.name,
    seller_location: product.seller.location,
    seller_avatar: product.seller.avatar || '',
    seller_bio: product.seller.bio || ''
  };

  const { data, error } = await supabase
    .from('listings')
    .insert([rowPayload])
    .select()
    .single();

  if (error) {
    throw new Error(`Database save failed: ${error.message}`);
  }

  return mapRowToProduct(data);
}

export async function deleteListingFromSupabase(listingId, ownerEmail) {
  if (!supabase) return true;

  if (!ownerEmail) {
    throw new Error('You must sign in as the seller to delete this listing.');
  }

  const { data, error } = await supabase.rpc('delete_my_listing', {
    p_listing_id: listingId,
    p_owner_email: ownerEmail.trim().toLowerCase()
  });

  if (error) {
    throw new Error(`Delete failed: ${error.message}`);
  }

  if (!data) {
    throw new Error('Only the seller who listed this product can delete it.');
  }

  return true;
}

export function subscribeToListings(onChange) {
  if (!supabase) return () => {};

  const channel = supabase
    .channel('public:listings-feed')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'listings' },
      () => {
        onChange();
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// =========================================================
// REAL USER-TO-USER MESSAGES (NO AUTOMATIC BOT REPLIES)
// =========================================================
export async function fetchUserMessagesFromSupabase(userEmail) {
  if (!supabase || !userEmail) return [];

  const cleanEmail = userEmail.trim().toLowerCase();
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(`buyer_email.eq.${cleanEmail},seller_email.eq.${cleanEmail}`)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to load messages: ${error.message}`);
  }

  return data || [];
}

export async function sendMessageInSupabase(payload) {
  if (!supabase) {
    return {
      id: Date.now(),
      created_at: new Date().toISOString(),
      ...payload
    };
  }

  const { data, error } = await supabase
    .from('messages')
    .insert([
      {
        listing_id: String(payload.listing_id),
        listing_name: payload.listing_name,
        listing_image: payload.listing_image || '',
        listing_price: Number(payload.listing_price || 0),
        seller_email: payload.seller_email.trim().toLowerCase(),
        seller_name: payload.seller_name,
        buyer_email: payload.buyer_email.trim().toLowerCase(),
        buyer_name: payload.buyer_name,
        sender_email: payload.sender_email.trim().toLowerCase(),
        sender_name: payload.sender_name,
        message_text: payload.message_text.trim()
      }
    ])
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to send message: ${error.message}`);
  }

  return data;
}

export async function deleteConversationInSupabase(listingId, buyerEmail) {
  if (!supabase) return true;

  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('listing_id', String(listingId))
    .eq('buyer_email', buyerEmail.trim().toLowerCase());

  if (error) {
    throw new Error(`Failed to delete conversation: ${error.message}`);
  }

  return true;
}

export function subscribeToUserMessages(userEmail, onChange) {
  if (!supabase || !userEmail) return () => {};

  const channel = supabase
    .channel(`public:messages:${userEmail.trim().toLowerCase()}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'messages' },
      () => {
        onChange();
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// =========================================================
// PER-ACCOUNT PERSISTENCE (WISHLIST, BAG, ORDERS, PROFILE)
// =========================================================
export async function fetchUserAccountFromSupabase(email) {
  if (!supabase || !email) return null;

  const cleanEmail = email.trim().toLowerCase();
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('email', cleanEmail)
    .maybeSingle();

  if (error) {
    console.error('Supabase profile load error:', error.message);
    return null;
  }

  return data;
}

export async function saveUserAccountToSupabase(userObj, accountState) {
  if (!supabase || !userObj?.email) return;

  const cleanEmail = userObj.email.trim().toLowerCase();
  const row = {
    email: cleanEmail,
    google_sub: userObj.googleSub || null,
    auth_provider: userObj.authProvider || 'gmail-form',
    email_verified: Boolean(userObj.emailVerified),
    name: userObj.name || cleanEmail.split('@')[0],
    password: userObj.password || null,
    location: userObj.location || '',
    role: userObj.role || 'Buyer & Seller',
    avatar: userObj.avatar || '',
    bio: userObj.bio || '',
    favorites: Array.isArray(accountState?.favorites)
      ? accountState.favorites
      : [],
    cart: Array.isArray(accountState?.cart) ? accountState.cart : [],
    orders: Array.isArray(accountState?.orders) ? accountState.orders : [],
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('user_profiles')
    .upsert([row], { onConflict: 'email' });

  if (error) {
    console.error('Supabase profile save error:', error.message);
  }
}