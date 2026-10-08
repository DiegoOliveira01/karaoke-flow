package dev.karaoke.web;

import java.io.IOException;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Convidados (qualquer IP diferente de localhost) só podem:
 *   - ler o catálogo e a mídia (GET/HEAD/OPTIONS)
 *   - adicionar uma música nova (POST /api/songs)
 *
 * Tudo o mais — apagar, trocar letra, trocar capa, alinhar palavras,
 * ajustar sincronia — é exclusivo do anfitrião, que acessa via 127.0.0.1.
 */
@Component
public class GuestRestrictionFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        if (isLocal(req) || isAllowedForGuest(req)) {
            chain.doFilter(req, res);
            return;
        }
        res.setStatus(HttpStatus.FORBIDDEN.value());
        res.setContentType("application/json;charset=UTF-8");
        res.getWriter().write("{\"message\":\"Apenas o anfitrião pode fazer isso.\"}");
    }

    private static boolean isLocal(HttpServletRequest req) {
        String a = req.getRemoteAddr();
        return "127.0.0.1".equals(a) || "::1".equals(a) || "0:0:0:0:0:0:0:1".equals(a);
    }

    private static boolean isAllowedForGuest(HttpServletRequest req) {
        String m = req.getMethod();
        String p = req.getRequestURI();
        // normaliza barra final: "/api/songs/" -> "/api/songs"
        if (p.length() > 1 && p.endsWith("/")) {
            p = p.substring(0, p.length() - 1);
        }
        if ("GET".equals(m) || "HEAD".equals(m) || "OPTIONS".equals(m)) {
            return true;   // leitura liberada (catálogo, mídia, buscas)
        }
        if ("POST".equals(m) && "/api/songs".equals(p)) {
            return true;   // adicionar música liberado
        }
        return false;      // todo o resto: negado
    }
}