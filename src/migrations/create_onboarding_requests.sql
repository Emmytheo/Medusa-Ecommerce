-- Create onboarding_requests table for vendor SMS onboarding
CREATE TABLE IF NOT EXISTS public.onboarding_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone TEXT,
    sender TEXT,
    name TEXT,
    business_name TEXT,
    store_type TEXT DEFAULT 'general',
    address TEXT,
    products JSONB DEFAULT '[]'::jsonb,
    raw_body TEXT,
    status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
    error_message TEXT,
    medusa_user_id TEXT,
    medusa_store_id TEXT,
    temporary_password TEXT,
    response_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for quick phone lookup
CREATE INDEX IF NOT EXISTS idx_onboarding_requests_phone ON public.onboarding_requests(phone);
CREATE INDEX IF NOT EXISTS idx_onboarding_requests_status ON public.onboarding_requests(status);
CREATE INDEX IF NOT EXISTS idx_onboarding_requests_created_at ON public.onboarding_requests(created_at DESC);

-- Enable RLS and grant access for anon and service_role
ALTER TABLE public.onboarding_requests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'onboarding_requests' AND policyname = 'Allow public inserts'
    ) THEN
        CREATE POLICY "Allow public inserts" ON public.onboarding_requests
            FOR INSERT WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'onboarding_requests' AND policyname = 'Allow public select'
    ) THEN
        CREATE POLICY "Allow public select" ON public.onboarding_requests
            FOR SELECT USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'onboarding_requests' AND policyname = 'Allow public update'
    ) THEN
        CREATE POLICY "Allow public update" ON public.onboarding_requests
            FOR UPDATE USING (true);
    END IF;
END $$;

GRANT ALL ON public.onboarding_requests TO anon, authenticated, service_role;
