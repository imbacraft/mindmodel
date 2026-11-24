package shop;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ExternalController {

  @PreAuthorize("hasRole('A')")
  @GetMapping("/api/v1/external/offers")
  public Object offers() {
    return "offers";
  }
}
