package com.frauddemo.api;

import static org.hamcrest.Matchers.closeTo;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Locale;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/** Exercises the HTTP endpoints end to end inside a running Spring context. */
@SpringBootTest
@AutoConfigureMockMvc
class ScoreControllerTest {

    @Autowired
    private MockMvc mvc;

    @Test
    void healthReportsModelAndThreshold() throws Exception {
        mvc.perform(get("/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"))
                .andExpect(jsonPath("$.model").value("fraud_autoencoder.onnx"))
                .andExpect(jsonPath("$.threshold").value(closeTo(6.7455, 1e-4)));
    }

    @Test
    void metricsServesPhase1Results() throws Exception {
        mvc.perform(get("/metrics"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.test.tp").value(31))
                .andExpect(jsonPath("$.test.n_transactions").value(56962));
    }

    @Test
    void scoresAReplayFraudCaseLikePython() throws Exception {
        ReplayData replay = ReplayData.load();
        int row = firstFlaggedFraud(replay);

        mvc.perform(post("/score").contentType(MediaType.APPLICATION_JSON).content(toJson(replay.features()[row], "replay-" + row)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value("replay-" + row))
                .andExpect(jsonPath("$.score").value(closeTo(replay.pythonScores()[row], 1e-4)))
                .andExpect(jsonPath("$.flagged").value(true));
    }

    @Test
    void missingFieldsAreRejectedWithA400() throws Exception {
        mvc.perform(post("/score").contentType(MediaType.APPLICATION_JSON).content("{\"Time\": 1, \"Amount\": 5}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value(containsString("V1")));
    }

    @Test
    void malformedJsonIsRejectedWithA400() throws Exception {
        mvc.perform(post("/score").contentType(MediaType.APPLICATION_JSON).content("not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").exists());
    }

    @Test
    void negativeAmountIsRejectedWithA400() throws Exception {
        float[] row = ReplayData.load().features()[0].clone();
        row[29] = -10f;
        mvc.perform(post("/score").contentType(MediaType.APPLICATION_JSON).content(toJson(row, "bad")))
                .andExpect(status().isBadRequest());
    }

    private static int firstFlaggedFraud(ReplayData replay) {
        for (int i = 0; i < replay.labels().length; i++) {
            if (replay.labels()[i] == 1 && replay.pythonFlagged()[i] == 1) {
                return i;
            }
        }
        throw new IllegalStateException("replay.csv has no flagged fraud case");
    }

    private static String toJson(float[] row, String id) {
        StringBuilder json = new StringBuilder("{\"id\": \"" + id + "\"");
        for (int i = 0; i < row.length; i++) {
            json.append(String.format(Locale.ROOT, ", \"%s\": %s", ScoringService.FEATURES.get(i), Float.toString(row[i])));
        }
        return json.append('}').toString();
    }
}
