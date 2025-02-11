import {
  discoverOAuthMetadata,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
} from "./auth.js";

// Mock pkce-challenge
jest.mock("pkce-challenge", () => ({
  __esModule: true,
  default: () => ({
    code_verifier: "test_verifier",
    code_challenge: "test_challenge",
  }),
}));

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("OAuth Authorization", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("discoverOAuthMetadata", () => {
    const validMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    };

    it("returns metadata when discovery succeeds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com");
      expect(metadata).toEqual(validMetadata);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          href: "https://auth.example.com/.well-known/oauth-authorization-server",
        })
      );
    });

    it("returns undefined when discovery endpoint returns 404", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com");
      expect(metadata).toBeUndefined();
    });

    it("throws on non-404 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(
        discoverOAuthMetadata("https://auth.example.com")
      ).rejects.toThrow("HTTP 500");
    });

    it("validates metadata schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // Missing required fields
          issuer: "https://auth.example.com",
        }),
      });

      await expect(
        discoverOAuthMetadata("https://auth.example.com")
      ).rejects.toThrow();
    });
  });

  describe("startAuthorization", () => {
    const validMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    };

    it("generates authorization URL with PKCE challenge", async () => {
      const { authorizationUrl, codeVerifier } = await startAuthorization(
        "https://auth.example.com",
        {
          redirectUrl: "http://localhost:3000/callback",
        }
      );

      expect(authorizationUrl.toString()).toMatch(
        /^https:\/\/auth\.example\.com\/authorize\?/
      );
      expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizationUrl.searchParams.get("code_challenge")).toBe("test_challenge");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
        "S256"
      );
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/callback"
      );
      expect(codeVerifier).toBe("test_verifier");
    });

    it("uses metadata authorization_endpoint when provided", async () => {
      const { authorizationUrl } = await startAuthorization(
        "https://auth.example.com",
        {
          metadata: validMetadata,
          redirectUrl: "http://localhost:3000/callback",
        }
      );

      expect(authorizationUrl.toString()).toMatch(
        /^https:\/\/auth\.example\.com\/authorize\?/
      );
    });

    it("validates response type support", async () => {
      const metadata = {
        ...validMetadata,
        response_types_supported: ["token"], // Does not support 'code'
      };

      await expect(
        startAuthorization("https://auth.example.com", {
          metadata,
          redirectUrl: "http://localhost:3000/callback",
        })
      ).rejects.toThrow(/does not support response type/);
    });

    it("validates PKCE support", async () => {
      const metadata = {
        ...validMetadata,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["plain"], // Does not support 'S256'
      };

      await expect(
        startAuthorization("https://auth.example.com", {
          metadata,
          redirectUrl: "http://localhost:3000/callback",
        })
      ).rejects.toThrow(/does not support code challenge method/);
    });
  });

  describe("exchangeAuthorization", () => {
    const validTokens = {
      access_token: "access123",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh123",
    };

    it("exchanges code for tokens", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validTokens,
      });

      const tokens = await exchangeAuthorization("https://auth.example.com", {
        authorizationCode: "code123",
        codeVerifier: "verifier123",
      });

      expect(tokens).toEqual(validTokens);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          href: "https://auth.example.com/token",
        }),
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        })
      );

      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("code123");
      expect(body.get("code_verifier")).toBe("verifier123");
    });

    it("validates token response schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // Missing required fields
          access_token: "access123",
        }),
      });

      await expect(
        exchangeAuthorization("https://auth.example.com", {
          authorizationCode: "code123",
          codeVerifier: "verifier123",
        })
      ).rejects.toThrow();
    });

    it("throws on error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      await expect(
        exchangeAuthorization("https://auth.example.com", {
          authorizationCode: "code123",
          codeVerifier: "verifier123",
        })
      ).rejects.toThrow("Token exchange failed");
    });
  });

  describe("refreshAuthorization", () => {
    const validTokens = {
      access_token: "newaccess123",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "newrefresh123",
    };

    it("exchanges refresh token for new tokens", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validTokens,
      });

      const tokens = await refreshAuthorization("https://auth.example.com", {
        refreshToken: "refresh123",
      });

      expect(tokens).toEqual(validTokens);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          href: "https://auth.example.com/token",
        }),
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        })
      );

      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh123");
    });

    it("validates token response schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // Missing required fields
          access_token: "newaccess123",
        }),
      });

      await expect(
        refreshAuthorization("https://auth.example.com", {
          refreshToken: "refresh123",
        })
      ).rejects.toThrow();
    });

    it("throws on error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      await expect(
        refreshAuthorization("https://auth.example.com", {
          refreshToken: "refresh123",
        })
      ).rejects.toThrow("Token exchange failed");
    });
  });

  describe("registerClient", () => {
    const validClientMetadata = {
      redirect_uris: ["http://localhost:3000/callback"],
      client_name: "Test Client",
    };

    const validClientInfo = {
      client_id: "client123",
      client_secret: "secret123",
      client_id_issued_at: 1612137600,
      client_secret_expires_at: 1612224000,
      ...validClientMetadata,
    };

    it("registers client and returns client information", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validClientInfo,
      });

      const clientInfo = await registerClient("https://auth.example.com", {
        clientMetadata: validClientMetadata,
      });

      expect(clientInfo).toEqual(validClientInfo);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          href: "https://auth.example.com/register",
        }),
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(validClientMetadata),
        })
      );
    });

    it("validates client information response schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // Missing required fields
          client_secret: "secret123",
        }),
      });

      await expect(
        registerClient("https://auth.example.com", {
          clientMetadata: validClientMetadata,
        })
      ).rejects.toThrow();
    });

    it("throws when registration endpoint not available in metadata", async () => {
      const metadata = {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      };

      await expect(
        registerClient("https://auth.example.com", {
          metadata,
          clientMetadata: validClientMetadata,
        })
      ).rejects.toThrow(/does not support dynamic client registration/);
    });

    it("throws on error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      await expect(
        registerClient("https://auth.example.com", {
          clientMetadata: validClientMetadata,
        })
      ).rejects.toThrow("Dynamic client registration failed");
    });
  });
});