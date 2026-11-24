package gw;

import org.springframework.web.bind.annotation.GetMapping;

public class Gw {

  @GetMapping("/ping")
  public String ping() {
    return "";
  }
}
