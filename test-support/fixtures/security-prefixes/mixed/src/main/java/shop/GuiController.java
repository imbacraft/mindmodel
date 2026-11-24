package shop;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class GuiController {

  @PreAuthorize("isAuthenticated()")
  @GetMapping("/api/v1/gui/children")
  public Object children() {
    return "children";
  }
}
