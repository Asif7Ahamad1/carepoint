CREATE DATABASE IF NOT EXISTS carepoint_booking
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
USE carepoint_booking;

CREATE TABLE IF NOT EXISTS doctors (
  id VARCHAR(40) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  specialty VARCHAR(80) NOT NULL,
  experience SMALLINT UNSIGNED NOT NULL,
  rating DECIMAL(3, 2) NOT NULL,
  fee DECIMAL(8, 2) NOT NULL,
  initials VARCHAR(4) NOT NULL,
  color VARCHAR(24) NOT NULL,
  about VARCHAR(180) NOT NULL,
  INDEX idx_doctors_specialty (specialty, name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patients (
  id VARCHAR(40) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS availability_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  doctor_id VARCHAR(40) NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL COMMENT '0=Sunday, 1=Monday, ..., 6=Saturday',
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  consultation_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  CONSTRAINT fk_rules_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  CONSTRAINT chk_rule_weekday CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT chk_rule_range CHECK (start_time < end_time),
  UNIQUE KEY uq_availability_rule (doctor_id, weekday, start_time),
  INDEX idx_rules_day (doctor_id, weekday, start_time)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_leave (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  doctor_id VARCHAR(40) NOT NULL,
  leave_date DATE NOT NULL,
  note VARCHAR(160) NULL,
  CONSTRAINT fk_leave_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  UNIQUE KEY uq_doctor_leave_date (doctor_id, leave_date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS appointment_slots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  doctor_id VARCHAR(40) NOT NULL,
  starts_at DATETIME(3) NOT NULL COMMENT 'Stored in UTC',
  ends_at DATETIME(3) NOT NULL COMMENT 'Stored in UTC',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_slot_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  UNIQUE KEY uq_doctor_slot (doctor_id, starts_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS appointments (
  id CHAR(36) PRIMARY KEY,
  doctor_id VARCHAR(40) NOT NULL,
  patient_id VARCHAR(40) NOT NULL,
  starts_at DATETIME(3) NOT NULL COMMENT 'UTC; displayed in the clinic timezone',
  ends_at DATETIME(3) NOT NULL COMMENT 'UTC',
  status ENUM('BOOKED', 'WAITLISTED', 'OFFERED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'EXPIRED') NOT NULL,
  token_number INT UNSIGNED NOT NULL,
  offered_until DATETIME(3) NULL,
  checked_in_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  active_doctor_id VARCHAR(40)
    GENERATED ALWAYS AS (
      CASE WHEN status IN ('BOOKED', 'OFFERED', 'CHECKED_IN')
        THEN doctor_id
        ELSE NULL
      END
    ) STORED,
  active_doctor_starts_at DATETIME(3)
    GENERATED ALWAYS AS (
      CASE WHEN status IN ('BOOKED', 'OFFERED', 'CHECKED_IN')
        THEN starts_at
        ELSE NULL
      END
    ) STORED,
  active_patient_id VARCHAR(40)
    GENERATED ALWAYS AS (
      CASE WHEN status IN ('BOOKED', 'OFFERED', 'CHECKED_IN')
        THEN patient_id
        ELSE NULL
      END
    ) STORED,
  active_patient_starts_at DATETIME(3)
    GENERATED ALWAYS AS (
      CASE WHEN status IN ('BOOKED', 'OFFERED', 'CHECKED_IN')
        THEN starts_at
        ELSE NULL
      END
    ) STORED,
  CONSTRAINT fk_appointment_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  CONSTRAINT fk_appointment_patient FOREIGN KEY (patient_id) REFERENCES patients(id),
  UNIQUE KEY uq_active_doctor_slot (active_doctor_id, active_doctor_starts_at),
  UNIQUE KEY uq_active_patient_start (active_patient_id, active_patient_starts_at),
  INDEX idx_doctor_queue (doctor_id, starts_at, status, token_number),
  INDEX idx_patient_schedule (patient_id, starts_at, ends_at, status),
  INDEX idx_waitlist_order (doctor_id, starts_at, status, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_daily_counters (
  doctor_id VARCHAR(40) NOT NULL,
  clinic_date DATE NOT NULL,
  last_token INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (doctor_id, clinic_date),
  CONSTRAINT fk_counter_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doctor_metrics (
  doctor_id VARCHAR(40) PRIMARY KEY,
  average_minutes DECIMAL(5, 1) NOT NULL DEFAULT 18.0,
  sample_count INT UNSIGNED NOT NULL DEFAULT 0,
  CONSTRAINT fk_metrics_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS appointment_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  appointment_id CHAR(36) NOT NULL,
  from_status ENUM('BOOKED', 'WAITLISTED', 'OFFERED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'EXPIRED') NULL,
  to_status ENUM('BOOKED', 'WAITLISTED', 'OFFERED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'EXPIRED') NOT NULL,
  actor_id VARCHAR(80) NOT NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_audit_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id),
  UNIQUE KEY uq_audit_transition (appointment_id, to_status),
  INDEX idx_audit_appointment_time (appointment_id, occurred_at)
) ENGINE=InnoDB;

DROP TRIGGER IF EXISTS trg_audit_log_no_update;
DROP TRIGGER IF EXISTS trg_audit_log_no_delete;
DELIMITER //
CREATE TRIGGER trg_audit_log_no_update
BEFORE UPDATE ON appointment_audit_log
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Appointment audit events are immutable.';
END//
CREATE TRIGGER trg_audit_log_no_delete
BEFORE DELETE ON appointment_audit_log
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Appointment audit events are immutable.';
END//
DELIMITER ;
