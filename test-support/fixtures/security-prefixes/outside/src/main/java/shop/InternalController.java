package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class InternalController {

  @GetMapping("/api/_/ping")
  public Object ping() {
    return "pong";
  }
}
