-- Create device command logs table
CREATE TABLE IF NOT EXISTS public.device_command_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    command_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'auth_failed')),
    payload JSONB NOT NULL,
    response JSONB,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indices for high-throughput lookup
CREATE INDEX IF NOT EXISTS idx_cmd_device_id ON public.device_command_logs (device_id);
CREATE INDEX IF NOT EXISTS idx_cmd_status ON public.device_command_logs (status);
CREATE INDEX IF NOT EXISTS idx_cmd_created_at ON public.device_command_logs (created_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.device_command_logs ENABLE ROW LEVEL SECURITY;

-- Service Role full access policy
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'device_command_logs' 
        AND policyname = 'Service role has full access to device_command_logs'
    ) THEN
        CREATE POLICY "Service role has full access to device_command_logs"
            ON public.device_command_logs
            FOR ALL
            TO service_role
            USING (true)
            WITH CHECK (true);
    END IF;
END
$$;

-- Authenticated and anon devices can insert and update command logs
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'device_command_logs' 
        AND policyname = 'Devices can insert and update command logs'
    ) THEN
        CREATE POLICY "Devices can insert and update command logs"
            ON public.device_command_logs
            FOR ALL
            TO anon, authenticated
            USING (true)
            WITH CHECK (true);
    END IF;
END
$$;
