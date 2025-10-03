-- Create blockchain_transactions table
CREATE TABLE IF NOT EXISTS blockchain_transactions (
  id SERIAL PRIMARY KEY,
  txid VARCHAR(255) NOT NULL UNIQUE,
  stream VARCHAR(100) NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create environmental_data table for caching latest readings
CREATE TABLE IF NOT EXISTS environmental_data (
  id SERIAL PRIMARY KEY,
  stream VARCHAR(100) NOT NULL UNIQUE,
  data JSONB NOT NULL,
  txid VARCHAR(255),
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_stream ON blockchain_transactions(stream);
CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_timestamp ON blockchain_transactions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_status ON blockchain_transactions(status);
CREATE INDEX IF NOT EXISTS idx_environmental_data_stream ON environmental_data(stream);
CREATE INDEX IF NOT EXISTS idx_environmental_data_timestamp ON environmental_data(timestamp DESC);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_blockchain_transactions_updated_at 
  BEFORE UPDATE ON blockchain_transactions 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_environmental_data_updated_at 
  BEFORE UPDATE ON environmental_data 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create RLS policies (if using Row Level Security)
ALTER TABLE blockchain_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE environmental_data ENABLE ROW LEVEL SECURITY;

-- Allow public read access to blockchain transactions
CREATE POLICY "Allow public read access to blockchain transactions" ON blockchain_transactions
  FOR SELECT USING (true);

-- Allow public read access to environmental data
CREATE POLICY "Allow public read access to environmental data" ON environmental_data
  FOR SELECT USING (true);

-- Allow authenticated users to insert blockchain transactions
CREATE POLICY "Allow authenticated insert to blockchain transactions" ON blockchain_transactions
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Allow authenticated users to insert environmental data
CREATE POLICY "Allow authenticated insert to environmental data" ON environmental_data
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Allow authenticated users to update environmental data
CREATE POLICY "Allow authenticated update to environmental data" ON environmental_data
  FOR UPDATE USING (auth.role() = 'authenticated');

-- Insert some sample data for testing
INSERT INTO environmental_data (stream, data, timestamp) VALUES
  ('air_quality', '{"aqi": 42, "pm25": 12, "location": "London", "status": "Good"}', NOW()),
  ('water_levels', '{"river_level": 2.4, "sea_level": 1.2, "location": "Thames", "status": "Normal"}', NOW()),
  ('seismic_activity', '{"magnitude": 2.1, "depth": 45, "location": "UK", "status": "Low"}', NOW()),
  ('advanced_metrics', '{"temperature": 22, "humidity": 65, "location": "London", "status": "Stable"}', NOW())
ON CONFLICT (stream) DO UPDATE SET
  data = EXCLUDED.data,
  timestamp = EXCLUDED.timestamp,
  updated_at = NOW();
