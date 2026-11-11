CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(160) NOT NULL,
  role ENUM('patient', 'doctor') NOT NULL,
  status ENUM('active', 'pending') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_auth_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_auth_session_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_applications (
  user_id CHAR(36) PRIMARY KEY,
  specialty VARCHAR(80) NOT NULL,
  experience SMALLINT UNSIGNED NOT NULL,
  fee DECIMAL(8, 2) NOT NULL,
  about VARCHAR(180) NOT NULL,
  license_number VARCHAR(80) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_doctor_application_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_doctor_application_license (license_number)
) ENGINE=InnoDB;
