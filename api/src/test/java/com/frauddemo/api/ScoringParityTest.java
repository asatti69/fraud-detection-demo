package com.frauddemo.api;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Proves the Java service gives the same scores and alert decisions as Python did in
 * Phase 1, on every row of data/replay.csv (all 75 test-set fraud cases + 2,000 normals).
 */
class ScoringParityTest {

    /** Same tolerance Phase 1 used for ONNX vs PyTorch: relative 1e-5, or absolute 1e-5 for scores below 1. */
    private static final double TOLERANCE = 1e-5;

    private static ScoringService service;
    private static ReplayData replay;

    @BeforeAll
    static void setUp() throws Exception {
        service = new ScoringService("../artifacts/fraud_autoencoder.onnx", "../artifacts/metrics.json");
        replay = ReplayData.load();
    }

    @AfterAll
    static void tearDown() throws Exception {
        service.close();
    }

    @Test
    void javaScoresMatchPythonScoresOnEveryReplayRow() throws Exception {
        float[] javaScores = service.score(replay.features());

        double maxRelDiff = 0;
        int alertMismatches = 0;
        for (int i = 0; i < javaScores.length; i++) {
            double py = replay.pythonScores()[i];
            double relDiff = Math.abs(javaScores[i] - py) / Math.max(1.0, Math.abs(py));
            maxRelDiff = Math.max(maxRelDiff, relDiff);
            assertThat(relDiff).as("row %d: java=%s python=%s", i, javaScores[i], py).isLessThanOrEqualTo(TOLERANCE);
            boolean javaFlagged = javaScores[i] >= service.threshold();
            if (javaFlagged != (replay.pythonFlagged()[i] == 1)) {
                alertMismatches++;
            }
        }
        System.out.printf("Parity: %d rows, max relative score difference %.2e, alert-decision mismatches %d%n",
                javaScores.length, maxRelDiff, alertMismatches);
        assertThat(javaScores).hasSize(2075);
        assertThat(alertMismatches).isZero();
    }

    /** The API scores one row at a time; ONNX Runtime may round the last float bit differently than in a batch. */
    @Test
    void singleRowScoringMatchesBatchScoring() throws Exception {
        float[] batch = service.score(replay.features());
        for (int i = 0; i < 50; i++) {
            float single = service.score(replay.features()[i]);
            assertThat(Math.abs(single - batch[i]) / Math.max(1.0, Math.abs(batch[i]))).isLessThanOrEqualTo(TOLERANCE);
        }
    }

    @Test
    void thresholdComesFromPhase1Metrics() {
        assertThat(service.threshold()).isBetween(6.7454, 6.7456);
    }
}
