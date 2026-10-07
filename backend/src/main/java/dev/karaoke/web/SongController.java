package dev.karaoke.web;

import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import dev.karaoke.model.Song;
import dev.karaoke.model.WordsFile;
import dev.karaoke.service.ItunesClient;
import dev.karaoke.service.LrclibClient;
import dev.karaoke.service.SongService;

@RestController
@RequestMapping("/api/songs")
public class SongController {

    public record LyricsChoice(long lrclibId) {
    }

    public record CoverChoice(String url) {
    }

    public record OffsetBody(int offsetMs) {
    }

    private final SongService service;
    private final LrclibClient lrclib;
    private final ItunesClient itunes;

    public SongController(SongService service, LrclibClient lrclib, ItunesClient itunes) {
        this.service = service;
        this.lrclib = lrclib;
        this.itunes = itunes;
    }

    @GetMapping
    public List<Song> list() {
        return service.list();
    }

    @GetMapping("/{id}")
    public Song get(@PathVariable String id) {
        return service.find(id).orElseThrow(SongController::notFound);
    }

    @PostMapping(consumes = "multipart/form-data")
    public ResponseEntity<Song> upload(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "title", required = false) String title,
            @RequestParam(value = "artist", required = false) String artist) {
        if (file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Arquivo vazio");
        }
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(service.create(file, title, artist));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        return service.delete(id) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    /** Baixa do LRCLIB a letra escolhida e guarda como lyrics.lrc. */
    @PutMapping("/{id}/lyrics")
    public Song setLyrics(@PathVariable String id, @RequestBody LyricsChoice body) {
        service.find(id).orElseThrow(SongController::notFound);
        String lrc;
        try {
            lrc = lrclib.fetchSynced(body.lrclibId());
        } catch (RestClientResponseException e) {
            if (e.getStatusCode().value() == 404) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Letra não encontrada no LRCLIB");
            }
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "LRCLIB respondeu com erro " + e.getStatusCode());
        } catch (RestClientException | IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Não consegui falar com o LRCLIB");
        }
        if (lrc.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Essa letra não tem sincronização");
        }
        return service.attachLyrics(id, lrc).orElseThrow(SongController::notFound);
    }

    /** Baixa a capa escolhida (só do CDN da Apple) e guarda como cover.*. */
    @PutMapping("/{id}/cover")
    public Song setCover(@PathVariable String id, @RequestBody CoverChoice body) {
        service.find(id).orElseThrow(SongController::notFound);
        ItunesClient.Image image;
        try {
            image = itunes.download(body.url());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        } catch (RestClientException e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Não consegui baixar a imagem");
        }
        return service.attachCover(id, image.bytes(), image.extension()).orElseThrow(SongController::notFound);
    }

    /** Pede o alinhamento palavra a palavra. Roda em segundo plano; acompanhe por wordsState. */
    @PostMapping("/{id}/words")
    public ResponseEntity<Song> requestWords(
            @PathVariable String id,
            @RequestParam(value = "language", defaultValue = "pt") String language) {
        if (!language.matches("[a-z]{2,3}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Idioma inválido");
        }
        try {
            Song song = service.requestWords(id, language).orElseThrow(SongController::notFound);
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(song);
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage());
        }
    }

    /** Salva palavras sincronizadas à mão no editor (substitui as atuais, venham de onde vierem). */
    @PutMapping("/{id}/words")
    public Song saveWords(@PathVariable String id, @RequestBody WordsFile body) {
        try {
            return service.saveWords(id, body).orElseThrow(SongController::notFound);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage());
        }
    }

    @PutMapping("/{id}/lyrics-offset")
    public Song setLyricsOffset(@PathVariable String id, @RequestBody OffsetBody body) {
        return service.setLyricsOffset(id, body.offsetMs()).orElseThrow(SongController::notFound);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Música não encontrada");
    }
}
