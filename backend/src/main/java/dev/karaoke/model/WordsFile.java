package dev.karaoke.model;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Conteúdo do words.json: palavras com tempo, geradas pelo alinhamento automático (Python)
 * ou criadas à mão no editor de sincronia. Os tempos estão no mesmo referencial da tela de karaokê
 * (já descontado o ajuste de sincronia da letra).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record WordsFile(Integer version, String language, String model, List<Line> lines) {

    /** Uma linha COM texto da letra. Se aligned=false, não há palavras e o player estima o tempo. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Line(double t, String text, boolean aligned, List<Word> words) {
    }

    public record Word(String w, double s, double e) {
    }
}
