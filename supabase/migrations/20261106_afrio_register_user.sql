-- Migration: afrio_register_user RPC
-- Provides reliable, pre-confirmed user creation bypassing SMTP mailer failures

CREATE OR REPLACE FUNCTION public.afrio_register_user(
  p_email text,
  p_password text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_user_id uuid;
  v_encrypted_pw text;
  v_now timestamptz := timezone('utc'::text, now());
  v_clean_email text := LOWER(TRIM(p_email));
BEGIN
  -- If user already exists in auth.users, update password and mark as confirmed
  IF EXISTS (SELECT 1 FROM auth.users WHERE LOWER(email) = v_clean_email) THEN
    UPDATE auth.users
    SET encrypted_password = crypt(p_password, gen_salt('bf', 10)),
        email_confirmed_at = COALESCE(email_confirmed_at, v_now),
        updated_at = v_now,
        raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || p_metadata
    WHERE LOWER(email) = v_clean_email
    RETURNING id INTO v_user_id;

    RETURN jsonb_build_object(
      'success', true,
      'user_id', v_user_id,
      'email', v_clean_email,
      'action', 'updated'
    );
  END IF;

  v_user_id := gen_random_uuid();
  v_encrypted_pw := crypt(p_password, gen_salt('bf', 10));

  -- Insert pre-confirmed user into auth.users (confirmed_at is GENERATED ALWAYS AS LEAST(email_confirmed_at, phone_confirmed_at))
  INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    invited_at,
    confirmation_token,
    confirmation_sent_at,
    recovery_token,
    recovery_sent_at,
    email_change_token_new,
    email_change,
    email_change_sent_at,
    last_sign_in_at,
    raw_app_meta_data,
    raw_user_meta_data,
    is_super_admin,
    created_at,
    updated_at,
    phone,
    phone_confirmed_at,
    phone_change,
    phone_change_token,
    phone_change_sent_at,
    email_change_token_current,
    email_change_confirm_status,
    banned_until,
    reauthentication_token,
    reauthentication_sent_at,
    is_sso_user,
    deleted_at,
    is_anonymous
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated',
    'authenticated',
    v_clean_email,
    v_encrypted_pw,
    v_now,
    NULL,
    '',
    NULL,
    '',
    NULL,
    '',
    '',
    NULL,
    NULL,
    '{"provider":"email","providers":["email"]}'::jsonb,
    p_metadata || jsonb_build_object('sub', v_user_id::text, 'email', v_clean_email, 'email_verified', true),
    NULL,
    v_now,
    v_now,
    p_metadata->>'phone',
    NULL,
    '',
    '',
    NULL,
    '',
    0,
    NULL,
    '',
    NULL,
    false,
    NULL,
    false
  );

  -- Insert matching email identity into auth.identities (email column is GENERATED ALWAYS AS LOWER(identity_data->>'email'))
  INSERT INTO auth.identities (
    id,
    provider_id,
    user_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    v_user_id::text,
    v_user_id,
    jsonb_build_object(
      'sub', v_user_id::text,
      'email', v_clean_email,
      'email_verified', true,
      'phone_verified', false
    ),
    'email',
    v_now,
    v_now,
    v_now
  );

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_user_id,
    'email', v_clean_email,
    'action', 'created'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.afrio_register_user(text, text, jsonb) TO anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';

