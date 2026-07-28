# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false
# pyright: reportAttributeAccessIssue=false

"""SPEC-152 acceptance tests: installation secret validation."""

from __future__ import annotations

import pytest


def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in (
        "APO_DEPLOYMENT_PROFILE", "APO_DATABASE_PROFILE", "APO_PUBLIC_URL",
        "AUTH_SECRET", "POSTGRES_PASSWORD",
        "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
        "GITHUB_REDIRECT_URI", "GITHUB_TOKEN_ENCRYPTION_KEY",
    ):
        monkeypatch.delenv(var, raising=False)


class TestAuthSecretProblem:
    def test_empty_required_fails(self) -> None:
        from apo.services.installation_secrets import auth_secret_problem
        assert auth_secret_problem("", required=True) is not None

    def test_empty_not_required_ok(self) -> None:
        from apo.services.installation_secrets import auth_secret_problem
        assert auth_secret_problem("", required=False) is None

    @pytest.mark.parametrize("p", ["change-me-in-production", "change-me", "dev-secret", "dev-secret-change-me", "secret", "SECRET", "  dev-secret  "])
    def test_placeholders_rejected(self, p: str) -> None:
        from apo.services.installation_secrets import auth_secret_problem
        assert auth_secret_problem(p, required=True) is not None

    def test_short_rejected(self) -> None:
        from apo.services.installation_secrets import auth_secret_problem
        assert auth_secret_problem("a" * 31, required=True) is not None

    def test_32_chars_ok(self) -> None:
        from apo.services.installation_secrets import auth_secret_problem
        assert auth_secret_problem("a" * 32, required=True) is None


class TestLoadConfig:
    def test_dev_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_secrets import load_installation_config
        _clear_env(monkeypatch)
        c = load_installation_config()
        assert c.deployment_profile == "development"

    def test_unknown_profile_fails(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_secrets import InstallationConfigError, load_installation_config
        _clear_env(monkeypatch)
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "sevrer")
        with pytest.raises(InstallationConfigError) as e:
            load_installation_config()
        assert "APO_DEPLOYMENT_PROFILE" in str(e.value)


class TestValidateSecrets:
    def test_local_without_secret_fails(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_secrets import InstallationConfigError, load_installation_config, validate_installation_secrets
        _clear_env(monkeypatch)
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        c = load_installation_config()
        with pytest.raises(InstallationConfigError) as e:
            validate_installation_secrets(c)
        assert "AUTH_SECRET" in str(e.value)

    def test_local_with_strong_secret_passes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_secrets import load_installation_config, validate_installation_secrets
        _clear_env(monkeypatch)
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        monkeypatch.setenv("AUTH_SECRET", "a" * 64)
        validate_installation_secrets(load_installation_config())

    def test_dev_without_secret_passes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_secrets import load_installation_config, validate_installation_secrets
        _clear_env(monkeypatch)
        validate_installation_secrets(load_installation_config())

    def test_postgres_without_password_fails(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_secrets import InstallationConfigError, load_installation_config, validate_installation_secrets
        _clear_env(monkeypatch)
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        monkeypatch.setenv("AUTH_SECRET", "a" * 64)
        monkeypatch.setenv("APO_DATABASE_PROFILE", "postgres")
        with pytest.raises(InstallationConfigError) as e:
            validate_installation_secrets(load_installation_config())
        assert "POSTGRES_PASSWORD" in str(e.value)

    def test_partial_github_oauth_fails(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_secrets import InstallationConfigError, load_installation_config, validate_installation_secrets
        _clear_env(monkeypatch)
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        monkeypatch.setenv("AUTH_SECRET", "a" * 64)
        monkeypatch.setenv("GITHUB_CLIENT_ID", "x")
        with pytest.raises(InstallationConfigError) as e:
            validate_installation_secrets(load_installation_config())
        assert "GITHUB" in str(e.value)

    def test_no_secret_in_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.installation_secrets import InstallationConfigError, load_installation_config, validate_installation_secrets
        _clear_env(monkeypatch)
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")
        marker = "UNIQUE_MARKER_a9f2k"
        monkeypatch.setenv("AUTH_SECRET", marker)
        with pytest.raises(InstallationConfigError) as e:
            validate_installation_secrets(load_installation_config())
        assert marker not in str(e.value)
