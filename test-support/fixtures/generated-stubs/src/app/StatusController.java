package app;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** The project's own mapping: the same endpoint with or without the generated root in the model. */
@RestController
public class StatusController {

    @GetMapping("/status")
    public String status() {
        return "up";
    }
}
