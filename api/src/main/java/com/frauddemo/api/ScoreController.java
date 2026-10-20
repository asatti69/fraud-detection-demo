package com.frauddemo.api;

import ai.onnxruntime.OrtException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ScoreController {

    private static final Logger log = LoggerFactory.getLogger(ScoreController.class);

    private final ScoringService scoring;

    public ScoreController(ScoringService scoring) {
        this.scoring = scoring;
    }

    public record ScoreResponse(Object id, double score, double threshold, boolean flagged,
                                String modelVersion, double latencyMs) {
    }

    /**
     * Scores one raw transaction. Body: {"Time": .., "V1": .., ..., "V28": .., "Amount": .., "id": optional}.
     */
    @PostMapping("/score")
    public ScoreResponse score(@RequestBody Map<String, Object> body) throws OrtException {
        long start = System.nanoTime();
        float[] row = toFeatureRow(body);
        double score = scoring.score(row);
        boolean flagged = score >= scoring.threshold();
        double latencyMs = (System.nanoTime() - start) / 1e6;
        Object id = body.get("id");

        log.atInfo()
                .addKeyValue("event", "transaction_scored")
                .addKeyValue("transaction_id", id)
                .addKeyValue("amount", row[29])
                .addKeyValue("score", score)
                .addKeyValue("threshold", scoring.threshold())
                .addKeyValue("flagged", flagged)
                .addKeyValue("latency_ms", latencyMs)
                .addKeyValue("model_version", scoring.modelVersion())
                .log(flagged ? "Transaction flagged" : "Transaction scored");

        return new ScoreResponse(id, score, scoring.threshold(), flagged, scoring.modelVersion(), latencyMs);
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> health = new LinkedHashMap<>();
        health.put("status", "UP");
        health.put("model", scoring.modelFile());
        health.put("modelVersion", scoring.modelVersion());
        health.put("threshold", scoring.threshold());
        return health;
    }

    /** Serves artifacts/metrics.json exactly as Phase 1 wrote it (held-out test results). */
    @GetMapping("/metrics")
    public ResponseEntity<String> metrics() {
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(scoring.metricsJson());
    }

    private static float[] toFeatureRow(Map<String, Object> body) {
        float[] row = new float[ScoringService.FEATURES.size()];
        List<String> missing = new ArrayList<>();
        for (int i = 0; i < row.length; i++) {
            String name = ScoringService.FEATURES.get(i);
            Object value = body.get(name);
            if (!(value instanceof Number number)) {
                missing.add(name);
                continue;
            }
            double v = number.doubleValue();
            if (!Double.isFinite(v)) {
                throw new IllegalArgumentException("Field " + name + " must be a finite number");
            }
            row[i] = (float) v;
        }
        if (!missing.isEmpty()) {
            throw new IllegalArgumentException("Missing or non-numeric fields: " + String.join(", ", missing));
        }
        if (row[0] < 0 || row[29] < 0) {
            throw new IllegalArgumentException("Time and Amount must not be negative");
        }
        return row;
    }
}
