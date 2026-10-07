package dev.karaoke.web;

import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClientException;
import org.springframework.web.server.ResponseStatusException;

import dev.karaoke.service.ItunesClient;
import dev.karaoke.service.ItunesClient.CoverResult;
import dev.karaoke.service.LrclibClient;
import dev.karaoke.service.LrclibClient.LyricsResult;

/** Buscas nos serviços externos (o navegador nunca fala direto com eles). */
@RestController
@RequestMapping("/api")
public class SearchController {

    private final LrclibClient lrclib;
    private final ItunesClient itunes;

    public SearchController(LrclibClient lrclib, ItunesClient itunes) {
        this.lrclib = lrclib;
        this.itunes = itunes;
    }

    @GetMapping("/lyrics/search")
    public List<LyricsResult> searchLyrics(
            @RequestParam("title") String title,
            @RequestParam(value = "artist", required = false) String artist) {
        if (title.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Informe o título");
        }
        try {
            return lrclib.search(title.trim(), artist);
        } catch (RestClientException | IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Não consegui consultar o LRCLIB");
        }
    }

    @GetMapping("/covers/search")
    public List<CoverResult> searchCovers(@RequestParam("term") String term) {
        if (term.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Informe um termo de busca");
        }
        try {
            return itunes.searchAlbums(term.trim());
        } catch (RestClientException | IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Não consegui consultar o iTunes");
        }
    }
}
