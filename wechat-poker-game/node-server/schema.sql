CREATE DATABASE IF NOT EXISTS four_player_poker
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE four_player_poker;

CREATE TABLE IF NOT EXISTS accounts (
  username VARCHAR(24) NOT NULL,
  password_salt VARCHAR(64) NOT NULL,
  password_hash VARCHAR(64) NOT NULL,
  password_iterations INT NOT NULL,
  profile_name VARCHAR(48) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  profile_avatar MEDIUMTEXT NOT NULL,
  profile_lock_room VARCHAR(6) NULL,
  profile_lock_expires_at BIGINT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (username),
  UNIQUE KEY unique_profile_name (profile_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS match_records (
  account_username VARCHAR(24) NOT NULL,
  record_id VARCHAR(64) NOT NULL,
  completed_at BIGINT NOT NULL,
  summary JSON NOT NULL,
  record JSON NOT NULL,
  PRIMARY KEY (account_username, record_id),
  CONSTRAINT match_records_account_fk
    FOREIGN KEY (account_username) REFERENCES accounts(username) ON DELETE CASCADE,
  KEY match_records_recent (account_username, completed_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
